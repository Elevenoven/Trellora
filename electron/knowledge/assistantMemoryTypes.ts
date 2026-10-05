import type { AssistantEvidenceCitation, CurrentNotePublicPlanEvent, CurrentNotePublicToolEvent } from './assistantTurnTypes';
import type { SearchPlan, SearchPlanStatus } from './searchPlanTypes';
import type { RollingSummaryPayload } from './assistantRollingSummary';
import type { CurrentNoteSearchScope } from './currentNoteSearchScope';

export const assistantMemoryModes = ['persistent', 'session-only', 'disabled'] as const;
export type AssistantMemoryMode = typeof assistantMemoryModes[number];

export interface AssistantMemorySettings {
  mode: AssistantMemoryMode;
  updatedAt: string;
}

/**
 * All session data must enter the repository through this complete scope.  The
 * database never accepts a note-only conversation query.
 */
export interface AssistantSessionScope {
  libraryId: string;
  noteId: string;
  sessionId: string;
}

export type AssistantSessionStatus = 'active' | 'archived';

export interface AssistantSessionSummary {
  sessionId: string;
  title: string;
  status: AssistantSessionStatus;
  turnCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface AssistantMemoryPage<T> {
  items: T[];
  nextCursor?: number;
}

export interface AssistantStoredTurn {
  turnId: string;
  turnSeq: number;
  userText: string;
  assistantText?: string;
  contextMode: string;
  status: 'pending' | 'complete' | 'partial' | 'not-found' | 'cancelled' | 'error' | 'interrupted';
  stopReason?: string;
  createdAt: string;
  finishedAt?: string;
  evidence: AssistantEvidenceCitation[];
  toolEvents: CurrentNotePublicToolEvent[];
  planStatus?: SearchPlanStatus;
  /** Final public plan snapshot reconstructed from the session-scoped SearchPlan. */
  planEvent?: CurrentNotePublicPlanEvent;
  executionElapsedMs?: number;
}

export interface AssistantSessionDetail {
  session: AssistantSessionSummary;
  rollingSummary: string;
  rollingSummaryVersion: number;
  rollingSummaryCoveredThroughSeq: number;
  rollingSummaryPayload: RollingSummaryPayload;
  turns: AssistantMemoryPage<AssistantStoredTurn>;
}

export interface AssistantMemoryTurnStart {
  userText: string;
  route: string;
  contextMode: string;
  providerFingerprint: string;
  model: string;
}

export interface AssistantMemoryTurnFinalize {
  answer: string;
  completeness: 'complete' | 'partial' | 'not-found';
  stopReason: string;
  contextMode: string;
  usage: Record<string, unknown>;
  evidence: AssistantEvidenceCitation[];
  searchPlan?: SearchPlan;
  /** Main-process-only v5 state; never populated from model output. */
  searchScope?: CurrentNoteSearchScope;
  /** Main-process authoritative coverage snapshot; contains IDs/counts only. */
  searchCoverage?: AssistantSearchGoalCoverage[];
}

/**
 * The durable subset of Coverage Ledger state.  It intentionally excludes
 * snippets, search observations, model rationale and any original note text.
 */
export interface AssistantSearchGoalCoverage {
  goalId: string;
  snapshotId: string;
  contentHash: string;
  queryFingerprint: string;
  matchedBlockCount: number;
  matchedHeadingCount: number;
  readHeadingCount: number;
  coveredAspectCount: number;
  targetAspectCount: number;
  discoveredHeadingIds: string[];
  readHeadingIds: string[];
  coveredAspects: string[];
  missingAspects: string[];
  candidateExhausted: boolean;
  candidateTruncated: boolean;
  nextSearchCursor?: string;
}

export interface AssistantSearchPlanPersistenceState {
  searchScope: CurrentNoteSearchScope;
  searchCoverage: AssistantSearchGoalCoverage[];
}

export interface AssistantSessionExport {
  format: 'markdown' | 'json';
  content: string;
  suggestedFileName: string;
}
