import type { MemoryKind, MemoryOrigin, MemoryStatus, MemoryWriteMode } from './memoryConstants';
import type { MemoryCitationSnapshot } from '../../../shared/memoryCitations';

export interface MemoryScope {
  workspaceId: string;
  principalId: string;
}

declare const trustedMemoryScopeBrand: unique symbol;

/** Only MemoryScopeResolver may create this value. Runtime trust is also checked with a WeakSet. */
export type TrustedMemoryScope = Readonly<MemoryScope> & {
  readonly [trustedMemoryScopeBrand]: true;
};

export interface TrustedMemoryScopeContext {
  scope: TrustedMemoryScope;
  workspacePath: string;
}

export interface WorkspaceMemoryConfig {
  enabled: boolean;
  writeMode: MemoryWriteMode;
  extractModelId: string | null;
  maxItems: number;
  extractDelaySeconds: number;
  extractMinIntervalSeconds: number;
  extractInstructions: string;
  interestThreshold: number;
  retrievalConditioning: boolean;
  embeddingModelId: string | null;
  vectorRecall: boolean;
}

export interface PrincipalMemoryConfig {
  enabled: boolean;
}

export interface AgentMemoryConfig {
  /** undefined means inherit; only an explicit false disables L4 for this agent. */
  memoryEnabled?: boolean;
}

export type LongTermMemoryUnavailableReason =
  | 'workspace-disabled'
  | 'principal-disabled'
  | 'agent-disabled';

export interface LongTermMemoryAvailability {
  enabled: boolean;
  reason?: LongTermMemoryUnavailableReason;
}

export interface MemorySubjectRecord extends MemoryScope {
  enabled: boolean;
  blockText: string;
  itemCount: number;
  lastExtractedAt: string | null;
  extractCursorAt: string | null;
  extractCursorMessageId: string | null;
  pendingSessionIds: string[];
  extractScheduledAt: string | null;
  consolidatedAt: string | null;
  forcedConsolidatedAt: string | null;
  memoryGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryExtractionJobStatus =
  | 'queued'
  | 'running'
  | 'retry'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'stale';

export interface MemoryExtractionJobRecord extends MemoryScope {
  id: string;
  capturedGeneration: number;
  status: MemoryExtractionJobStatus;
  dueAt: string;
  attempts: number;
  claimedSessionIds: string[];
  claimedSources?: MemoryExtractionSourceClaim[];
  sourceModelProfileId: string | null;
  sourceModelId: string | null;
  sourceContextWindowTokens: number | null;
  leaseUntil: string | null;
  lastError: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryExtractionSourceClaim {
  turnId: string;
  fingerprint: string;
  generation: number;
}

export interface MemoryExtractionRuntimeStatus {
  routes: Array<{ route: 'chat' | 'knowledge-base' | 'current-note-direct' | 'current-note-react';
    readEnabled: boolean; readReason: 'enabled' | 'memory_disabled' | 'route_disabled';
    eligible: boolean; reason: 'eligible' | 'memory_disabled' | 'explicit_only' | 'route_disabled' | 'paused' }>;
  modelState: 'unknown' | 'ready' | 'unavailable';
  lastModelValidatedAt?: string;
  queuedJobs: number;
  runningJobs: number;
  failedJobs: number;
  pendingSources: number;
  migrationHeldJobs: number;
  nextDueAt: string | null;
  pauseCode?: 'MEMORY_PROTOCOL_UPGRADE_REQUIRED';
}

/** A main-process receipt, emitted only after the local save transaction finishes. */
export interface MemorySaveReceipt {
  status: 'saved' | 'pending' | 'disabled' | 'failed';
  itemId?: string;
  itemStatus?: MemoryStatus;
  archivedItemIds?: string[];
  code?: string;
}

export type MemoryProposalAction = 'add' | 'replace' | 'retire';
export type MemoryWriteProtection = 'user' | 'none' | 'legacy';
export type MemoryReviewReason = 'INFERRED_FACT' | 'TARGET_REPLACEMENT' | 'TARGET_RETIREMENT'
  | 'AMBIGUOUS_RELATION' | 'LEGACY_PROPOSAL' | 'TARGET_CHANGED' | 'TARGET_DELETED' | 'TARGET_EXPIRED';
export interface MemoryTargetSnapshot {
  id: string;
  kind: MemoryKind;
  content: string;
  topic: string;
  importance: number;
  expiresAt: string | null;
  memoryGeneration: number;
}
/** Optimistic review parameters; owner and target fingerprints are always revalidated in main. */
export interface MemoryProposalReview {
  expectedAction: MemoryProposalAction;
  expectedProposalFingerprint: string;
  targetItemId?: string;
  expectedTargetFingerprint?: string;
}

export interface MemoryProposalContext {
  proposal: MemoryItemRecord;
  currentTarget: MemoryItemRecord | null;
  availableTargets: MemoryItemRecord[];
  sourceQuote: string | null;
  invalidReason: 'TARGET_CHANGED' | 'TARGET_EXPIRED' | null;
}

export interface MemoryTurnStatus {
  turnId: string;
  memoryEnabled: boolean;
  explicit: { itemId: string; currentStatus: MemoryStatus | 'deleted' | 'cleared' } | null;
  extraction: {
    status: 'waiting' | 'running' | 'retry' | 'failed' | 'applied' | 'disabled' | 'stale';
    reason?: string;
    nextDueAt?: string;
    summary?: { active: number; pending: number; reused: number; archived: number; itemIds: string[]; skipped: string[] };
    currentItems?: Array<{ id: string; status: MemoryStatus | 'deleted' | 'cleared' }>;
  };
}

export interface ClaimedMemoryExtractionJob extends MemoryExtractionJobRecord {
  trustedScope: TrustedMemoryScope;
  workspacePath: string;
}

export interface MemoryItemRecord extends MemoryScope {
  id: string;
  kind: MemoryKind;
  content: string;
  topic: string;
  normalizedKey: string;
  importance: number;
  origin: MemoryOrigin;
  status: MemoryStatus;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  validFrom: string;
  invalidAt: string | null;
  expiresAt: string | null;
  supersededBy: string | null;
  lastUsedAt: string | null;
  useCount: number;
  memoryGeneration: number;
  createdAt: string;
  updatedAt: string;
  proposalAction: MemoryProposalAction | null;
  replacesId: string | null;
  replacesFingerprint: string | null;
  replacesSnapshot: MemoryTargetSnapshot | null;
  reviewReason: MemoryReviewReason | null;
  writeProtection: MemoryWriteProtection;
  /** Read-only main-process projection; counters do not invalidate review. */
  proposalFingerprint?: string;
  targetFingerprint?: string;
}

export interface MemoryWriteInput {
  operation?: MemoryProposalAction;
  targetItemId?: string;
  expectedTargetFingerprint?: string;
  reviewReason?: MemoryReviewReason;
  kind?: MemoryKind;
  content: string;
  topic?: string;
  importance?: number;
  origin: MemoryOrigin;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  expiresAt?: string | null;
  /** Extracted facts are conservative pending proposals unless explicitly false. */
  inferred?: boolean;
  /** Durable jobs must carry their captured generation to prevent post-clear writes. */
  memoryGeneration?: number;
}

export interface MemoryExtractionModelHint {
  profileId?: string | null;
  modelId?: string | null;
  contextWindowTokens?: number | null;
}

export interface MemoryExtractionDecision {
  operation: 'add' | 'update' | 'delete' | 'none';
  targetItemId: string | null;
  relation: 'independent' | 'supplement' | 'correction' | 'uncertain';
  evidenceQuote: string;
  kind: Exclude<MemoryKind, 'interest'>;
  content: string;
  topic?: string;
  importance?: number;
  inferred: boolean;
  sourceMessageId: string;
  expiresAt?: string | null;
}

export interface MemoryExtractionOutput {
  schemaVersion: 2;
  topics: string[];
  decisions: MemoryExtractionDecision[];
}

export interface MemoryExtractionUserMessage {
  messageId: string;
  sessionId: string;
  content: string;
  createdAt: string;
  sourceFingerprint?: string;
}

export interface ManualMemoryInput {
  kind: MemoryKind;
  content: string;
  topic?: string;
  importance?: number;
  expiresAt?: string | null;
}

export interface MemoryItemPatch {
  expectedFingerprint?: string;
  kind?: MemoryKind;
  content?: string;
  topic?: string;
  importance?: number;
  expiresAt?: string | null;
}

export interface MemoryWriteResult {
  action: 'created' | 'unchanged' | 'superseded';
  item: MemoryItemRecord;
  replacedItemId?: string;
  redacted: boolean;
  archivedItemIds: string[];
}

export interface MemoryItemListQuery {
  cursor?: string;
  limit?: number;
  statuses?: MemoryStatus[];
  kinds?: MemoryKind[];
}

export interface MemoryItemPage {
  items: MemoryItemRecord[];
  nextCursor?: string;
}

/** Management pagination is independent of the existing recall/extraction cursor contract. */
export interface MemoryPageQuery {
  page?: number;
  pageSize?: number;
}

export interface MemoryItemPageQuery extends MemoryPageQuery {
  statuses?: MemoryStatus[];
  kinds?: MemoryKind[];
}

export interface MemoryPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface MemoryItemCounts {
  active: number;
  pending: number;
  all: number;
}

export interface MemoryClearResult {
  deletedItems: number;
  retainedTombstones: number;
  memoryGeneration: number;
}

export interface MemoryExportDocument {
  contractVersion: string;
  exportedAt: string;
  items: MemoryItemRecord[];
}

export interface MemoryImportResult {
  importedItems: number;
  unchangedItems: number;
  skippedItems: number;
}

export interface MemoryDocumentCitation {
  documentId: string;
  title?: string;
  knowledgeBaseId?: string;
}

export interface MemoryDocumentAffinity extends MemoryScope {
  documentId: string;
  knowledgeBaseId: string | null;
  title: string;
  hits: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

export interface MemoryTopicRecord {
  id: string;
  normalizedKey: string;
  topic: string;
  aliases: string[];
  hits: number;
  promotedItemId: string | null;
}

export interface MemoryUsedSnapshot extends MemoryCitationSnapshot {
  usedAt: string;
}

export type MemoryConsolidationMode = 'automatic' | 'manual';
export type MemoryConsolidationSkipReason =
  | 'review_required'
  | 'too_soon'
  | 'too_few_items'
  | 'no_candidates'
  | 'model_unavailable'
  | 'model_declined'
  | 'sources_skipped'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'failed';

export interface MemoryConsolidationResult {
  previews?: MemoryConsolidationPreview[];
  mode: MemoryConsolidationMode;
  archivedExpired: number;
  decayedTasks: number;
  candidateClusters: number;
  mergedClusters: number;
  mergedItemIds: string[];
  skippedChangedClusters?: number;
  skippedExpiryClusters?: number;
  skippedClusters?: Array<{ itemIds: string[]; reason: 'SOURCE_CHANGED' | 'EXPIRY_MISMATCH' | 'SOURCE_EXPIRED' | 'TARGET_CONFLICT' }>;
  skipReason?: MemoryConsolidationSkipReason;
  completedAt: string;
}

export interface MemoryConsolidationPreview {
  id: string;
  fingerprint: string;
  sources: Array<Pick<MemoryItemRecord, 'id' | 'kind' | 'content' | 'topic' | 'importance' | 'expiresAt' | 'writeProtection'>>;
  result: { kind: MemoryKind; content: string; topic: string; importance: number; expiresAt: string | null };
  expiresAt: string;
}

export interface MemoryMigrationReport {
  profile: { completed: number; skipped: number; failed: number };
  currentNote: { completed: number; skipped: number; failed: number };
}
