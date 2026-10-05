import type { CurrentNoteSearchScopePlannerInput } from './currentNoteSearchScope';

export const searchGoalStatuses = [
  'pending',
  'searching',
  'partial',
  'covered',
  'conflicted',
  'not-found',
] as const;

export type SearchGoalStatus = typeof searchGoalStatuses[number];

export const searchPlanStatuses = [
  'active',
  'completed',
  'partial',
  'not-found',
  'failed',
  'cancelled',
  'stale',
  'interrupted',
] as const;

export type SearchPlanStatus = typeof searchPlanStatuses[number];

export const searchEvidenceKinds = ['fact', 'definition', 'comparison', 'cause', 'timeline'] as const;
export type SearchEvidenceKind = typeof searchEvidenceKinds[number];

export const searchQueryTermSources = [
  'planner',
  'note-map',
  'search-observation',
  'model-synonym',
  'user-confirmed',
] as const;

export type SearchQueryTermSource = typeof searchQueryTermSources[number];
export type SearchQueryVariantSource = Exclude<SearchQueryTermSource, 'planner'>;

export const searchPlanCompleteness = ['complete', 'partial', 'not-found'] as const;
export type SearchPlanCompleteness = typeof searchPlanCompleteness[number];

/** Technical execution/projection bounds; SearchPlan itself has no cumulative QueryTerm count limit. */
export const SEARCH_QUERY_TERM_BATCH_SIZE = 8;
export const SEARCH_QUERY_TERM_PROJECTION_LIMIT = 16;
export const SEARCH_QUERY_VARIANTS_PER_PATCH = 4;

export const DEFAULT_SEARCH_PLAN_BUDGET = {
  maxGoals: 4,
  maxRequirementsPerGoal: 4,
  maxEvidencePerRequirementBinding: 4,
  maxEvidencePerConflictSide: 4,
  maxPlanRevisions: 2,
  maxGoalUpdates: 8,
} as const;

export interface SearchEvidenceRequirement {
  requirementId: string;
  label: string;
  subject?: string;
  minEvidence: number;
}

export interface SearchEvidenceBinding {
  requirementId: string;
  evidenceIds: string[];
}

export interface SearchConflictBinding {
  requirementId: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

export interface SearchQueryTerm {
  term: string;
  source: SearchQueryTermSource;
}

export interface SearchGoal {
  goalId: string;
  question: string;
  evidenceKind: SearchEvidenceKind;
  requirements: SearchEvidenceRequirement[];
  queryTerms: SearchQueryTerm[];
  status: SearchGoalStatus;
  evidenceBindings: SearchEvidenceBinding[];
  conflictBindings: SearchConflictBinding[];
  missingEvidence?: string;
}

export interface SearchPlan {
  planId: string;
  version: number;
  originalQuestion: string;
  goals: SearchGoal[];
  activeGoalId: string | null;
  status: SearchPlanStatus;
  revisionCount: number;
  goalUpdateCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The only model-facing shape accepted when a plan is first created. */
export interface SearchPlannerGoalInput {
  goalId?: string;
  question: string;
  evidenceKind: SearchEvidenceKind;
  requirements: SearchEvidenceRequirement[];
  queryTerms: string[];
}

export interface SearchPlannerOutput {
  scope?: CurrentNoteSearchScopePlannerInput;
  goals: SearchPlannerGoalInput[];
}

export interface SearchPlanDraft {
  originalQuestion: string;
  goals: Array<{
    goalId?: string;
    question: string;
    evidenceKind: SearchEvidenceKind;
    requirements: SearchEvidenceRequirement[];
    queryTerms: Array<string | SearchQueryTerm>;
  }>;
}

export interface QueryVariant {
  term: string;
  source: SearchQueryVariantSource;
}

export interface SearchPlanPatchGoalUpdate {
  goalId: string;
  status?: SearchGoalStatus;
  queryVariants?: QueryVariant[];
  evidenceBindings?: SearchEvidenceBinding[];
  conflictBindings?: SearchConflictBinding[];
  missingEvidence?: string | null;
}

export interface SearchPlanPatch {
  baseVersion: number;
  activeGoalId?: string | null;
  goalOrder?: string[];
  goalUpdates: SearchPlanPatchGoalUpdate[];
}

/** An answer may carry its final coverage patch; it is not a separate tool. */
export interface SearchPlanAnswerAction {
  type: 'answer';
  answer: string;
  citations?: string[];
  completeness: SearchPlanCompleteness;
  planPatch?: SearchPlanPatch;
}

export type SearchPlanEvidenceIds = ReadonlySet<string> | readonly string[];

export interface SearchPlanValidationOptions {
  evidenceIds?: SearchPlanEvidenceIds;
  /** Controller-provided lexical scope for non-model query variants. */
  queryVariantScope?: SearchQueryVariantScope;
  /** Internal allowance for an answer that is atomically terminating the active turn. */
  allowActiveGoalClear?: boolean;
  /** Stage 6: a completed all-retrieved answer needs one valid source per requirement, not the legacy count. */
  relaxRequirementMinEvidence?: boolean;
  /** Stage 6: a conflicted goal may be complete when both sides are cited and explained. */
  allowConflictedComplete?: boolean;
}

export interface SearchQueryVariantScope {
  noteMapTerms?: readonly string[];
  searchObservationTerms?: readonly string[];
  userConfirmedTerms?: readonly string[];
}

export interface SearchPlanPatchOptions extends SearchPlanValidationOptions {
  now?: string;
  /** The answer path may clear activeGoalId while terminating the plan. */
  isAnswerFinalizing?: boolean;
}
