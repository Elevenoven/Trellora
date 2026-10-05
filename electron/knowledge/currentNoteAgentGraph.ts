import { createHash } from 'node:crypto';
import type { AiProviderKind } from './aiTypes';
import type { AssistantAnswerDepth, AssistantConversationMessage, AssistantEvidenceCitation, CurrentNoteAgentStats, CurrentNoteContextMode, CurrentNotePublicPlanEvent, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, CurrentNoteToolStats, EvidencePromptManifest } from './assistantTurnTypes';
import { formatAnswerDepthRules } from './assistantAnswerPolicy';
import { createCurrentNotePrompt } from './currentNotePrompt';
import { CurrentNoteEvidenceLedger, type CurrentNoteEvidenceRecord } from './currentNoteEvidenceLedger';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { batchCurrentNoteSearchTerms, createCurrentNoteTools, CURRENT_NOTE_SEARCH_TERM_LIMIT, materializeCurrentNoteSearchHits, type CurrentNoteMapDetail, type CurrentNoteReadLimits } from './currentNoteTools';
import { createMemoryEntry, MemoryCoverageJudge, NoteConversationMemory } from './noteConversationMemory';
import { createCurrentNotePlanPrompt, createCurrentNotePlanRepairPrompt, createFallbackCurrentNotePlanResult, isCurrentNotePlanValidationError, type AssistantPlanMode, type CurrentNotePlanDriver, type CurrentNotePlanResult } from './searchPlanDriver';
import { isToolCapabilityActive, renderToolCapabilityPrompt, type ToolCapabilityPhase } from './toolCapabilityCatalog';
import { createFallbackCurrentNoteSearchScope, type CurrentNoteSearchScope } from './currentNoteSearchScope';
import type { QueryVariant, SearchGoal, SearchPlan } from './searchPlanTypes';
import {
  applyModelSearchPlanPatch,
  applySearchPlanPatch,
  isSearchGoalExecutable,
  markSearchPlanStale,
  setSearchPlanControllerStatus,
} from './searchPlanValidation';
import { StructuredActionError, type CurrentNoteAgentAction, type CurrentNoteToolName, type StructuredActionDriver, type StructuredActionErrorCode } from './structuredActionDriver';
import { estimateAssistantContextUsage, estimateTokenCount, type AssistantContextUsage, type AssistantPromptStats, type AssistantTokenUsage } from './tokenEstimator';
import { normalizeTechnicalTerm } from './lexicalMatchPolicy';
import { tokenizeCurrentNoteText } from './currentNoteStructure';
import type { CurrentNoteSearchHit } from './currentNoteLexicalIndex';
import type { EffectiveContextWindow } from '../../shared/effectiveContextWindow';
import { isAiContextOverflow } from './aiProviderError';
import { ModelCallBudgetGate, type ModelCallTicket } from './modelCallBudget';
import { PromptBudgetScheduler, type PromptCallKind, type PromptBudgetPlan } from './currentNoteContextBudget';
import { PlanExecutionTraceStore } from './planExecutionTraceStore';
import { createCurrentNoteDecideJsonSchema, DEFAULT_PLAN_JSON_SCHEMA, DEFAULT_SYNTHESIZE_JSON_SCHEMA, deriveEvidenceCompressionProtectionIds, PlanAwarePromptProjector, type LatestEvidenceObservation, type PromptProjection, type PromptProjectionLevel } from './planAwarePromptProjector';
import { sharedTokenCalibrationStore, type TokenCalibrationStore } from './tokenCalibration';
import type { AdaptiveContextMode, AssistantEvidenceProjectionMode, EvidenceCompressionMode } from './assistantMode';
import { ModelCallCoordinator, type ModelCallCoordinator as ModelCallCoordinatorType } from './modelCallCoordinator';
import { EvidenceCompressionCache } from './evidenceCompressionCache';
import { EvidenceCompressionDriver } from './evidenceCompressionDriver';
import { planEvidenceCompressionBatches } from './evidenceCompressionPlanner';
import type { EvidenceCompressionArtifact, EvidenceCompressionBatch, EvidenceCompressionCacheStateVector, EvidenceCompressionConflictBinding, EvidenceCompressionSourceEvidence } from './evidenceCompressionTypes';
import { CurrentNoteSearchCoverageLedger, type CurrentNoteCoverageReadInput, type CurrentNoteSearchCoverageSummary } from './currentNoteSearchCoverage';
import type { AssistantSearchPlanPersistenceState } from './assistantMemoryTypes';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS } from '../../shared/assistantContextBudget';
import { projectPublicSearchPlan, sanitizeQueryTerms } from './publicSearchPlan';
import { toDetailedTraceError, type AssistantDetailedTraceSink } from './assistantDetailedTrace';
import { isStructuredOutputContractError } from './structuredOutputContract';
import { ContextMemoryRegistry } from './contextMemoryRegistry';
import {
  CurrentNoteContextMemoryAdapter,
  resolveCurrentNoteMemoryBudgets,
  type CurrentNoteContextRuntimeInput,
} from './currentNoteContextMemoryAdapter';
import { ProjectContextAdapter } from './projectContextAdapter';
import { createContextProjectionDiagnostics } from './contextProjectionDiagnostics';
import type { AssistantContextRuntimeMode, ContextMaterial, ContextProjectionDiagnostics } from './contextRuntimeTypes';
import { resolveAssistantModelRuntimeProfile } from '../../shared/effectiveContextWindow';
import type { QaAgentMessageInput } from './qaMemoryTypes';
import type { SearchConversationsToolRuntime } from './knowledgeTools/searchConversationsTool';

export interface CurrentNoteAgentBudget {
  maxDecisionRounds: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInvalidActions: number;
  maxRepeatedActionSignatures: number;
  maxSingleObservationChars: number;
  maxRawEvidenceChars: number;
  /** Omit to let the turn run until a non-time budget or user cancellation stops it. */
  maxWallTimeMs?: number;
  maxNoProgressRounds: number;
  maxEvidenceCompressionCalls?: number;
  maxCompressionRounds?: number;
  maxCompressionBatches?: number;
  finalSynthesisReserveMs?: number;
}

type AllRetrievedTurnBudget = CurrentNoteAgentBudget & Required<Pick<CurrentNoteAgentBudget,
  'maxEvidenceCompressionCalls' | 'maxCompressionRounds' | 'maxCompressionBatches' | 'finalSynthesisReserveMs'>>;

export const DEFAULT_CURRENT_NOTE_AGENT_BUDGET: Readonly<CurrentNoteAgentBudget> = Object.freeze({
  // One public snapshot read is charged before ReAct starts. Ten calls leave
  // room for map + search + several chapter reads in a multi-evidence turn.
  maxDecisionRounds: 10,
  maxModelCalls: 12,
  maxToolCalls: 10,
  maxInvalidActions: 3,
  maxRepeatedActionSignatures: 1,
  maxSingleObservationChars: 12_000,
  // At the 128K application window this permits roughly 15% of the prompt to
  // be grounded in raw evidence for complex, multi-section questions.
  maxRawEvidenceChars: 72_000,
  maxNoProgressRounds: 3,
});

export const DEFAULT_ALL_RETRIEVED_TURN_BUDGET: Readonly<AllRetrievedTurnBudget> = Object.freeze({
  ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET,
  maxModelCalls: 18,
  maxEvidenceCompressionCalls: 5,
  maxCompressionRounds: 2,
  maxCompressionBatches: 6,
  finalSynthesisReserveMs: 60_000,
});

/** Stable planner vocabulary: trim, drop empty entries, exact-string dedupe. */
export function collectStableSearchPlanQueryTerms(plan: SearchPlan): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const goal of plan.goals) {
    for (const queryTerm of goal.queryTerms) {
      const term = queryTerm.term.trim();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

/** Stable vocabulary for one goal. Pending variants are appended without rewriting accepted terms. */
export function collectStableSearchGoalQueryTerms(
  plan: SearchPlan,
  goalId: string,
  pendingVariants: readonly string[] = [],
): string[] {
  const goal = plan.goals.find((candidate) => candidate.goalId === goalId);
  if (!goal) return [];
  return stableOrderedTerms([
    ...goal.queryTerms.map((queryTerm) => queryTerm.term),
    ...pendingVariants,
  ]);
}

/** Exposes the mechanical batch contract without changing term text. */
export function createStableSearchPlanTermBatches(plan: SearchPlan, maxTerms = CURRENT_NOTE_SEARCH_TERM_LIMIT): string[][] {
  return batchCurrentNoteSearchTerms(collectStableSearchPlanQueryTerms(plan), maxTerms);
}

/** Selects one deterministic execution batch for a goal without mutating plan vocabulary. */
export function createStableSearchGoalTermBatch(
  plan: SearchPlan,
  goalId: string,
  offset: number,
  pendingVariants: readonly string[] = [],
  maxTerms = CURRENT_NOTE_SEARCH_TERM_LIMIT,
): string[] {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('QueryTerm 批次偏移无效。');
  if (!Number.isInteger(maxTerms) || maxTerms < 1) throw new Error('QueryTerm 批次上限无效。');
  return collectStableSearchGoalQueryTerms(plan, goalId, pendingVariants).slice(offset, offset + maxTerms);
}

export interface CurrentNoteAgentResult {
  answer: string;
  contextMode: Extract<CurrentNoteContextMode, 'react-search' | 'memory-reuse'>;
  evidence: ReturnType<CurrentNoteEvidenceLedger['toCitations']>;
  completeness: 'complete' | 'partial' | 'not-found';
  toolStats: CurrentNoteToolStats;
  agentStats: CurrentNoteAgentStats;
  prefixFingerprint: string;
  contextUsage: AssistantContextUsage;
  route: 'react-search' | 'clarify';
  searchPlan?: SearchPlan;
  /** Main-process resolved adaptive scope; persistence receives it separately from model output. */
  searchScope?: CurrentNoteSearchScope;
  /** Main-process authoritative coverage summary; never accepted from model actions. */
  coverage?: CurrentNoteSearchCoverageSummary;
  promptStats?: AssistantPromptStats;
  contextDiagnostics?: ContextProjectionDiagnostics;
  /** Canonical L2 assistant/tool steps for exact turn replay. */
  agentMessages: QaAgentMessageInput[];
}

export interface CurrentNoteAgentInput {
  snapshot: CurrentNoteSnapshot;
  question: string;
  conversation: AssistantConversationMessage[];
  providerKind: AiProviderKind;
  model: string;
  /** UI-selected answer shape, applied to final synthesis for the current-note route. */
  answerDepth?: AssistantAnswerDepth;
  contextWindowTokens?: number;
  contextWindow?: Pick<EffectiveContextWindow, 'source' | 'confidence' | 'warning'>;
  skillInstructions?: string[];
  signal: AbortSignal;
  driver: StructuredActionDriver;
  memory: NoteConversationMemory;
  memoryScopeKey: string;
  isSnapshotCurrent: () => boolean;
  onToolEvent?: (event: CurrentNotePublicToolEvent) => void;
  onPlanEvent?: (event: CurrentNotePublicPlanEvent) => void;
  /** Turn-scoped main-process JSONL audit sink. It never participates in control flow. */
  onDetailedTrace?: AssistantDetailedTraceSink;
  /** Main-process-only persistence callback; it receives structure and validated ledger citations, never hidden reasoning. */
  onPlanState?: (plan: SearchPlan, evidence: AssistantEvidenceCitation[], persistence?: AssistantSearchPlanPersistenceState) => void;
  /** Public tool calls completed before entering ReAct share the same turn budget. */
  toolCallsAlreadyUsed?: number;
  /** `current-note` adds one bounded initial plan; `off` preserves the old loop. */
  planMode?: AssistantPlanMode;
  planner?: CurrentNotePlanDriver;
  /** A turn-level gate supplied by main; absent means a standalone fixture gate. */
  modelCallGate?: ModelCallBudgetGate;
  budget?: CurrentNoteAgentBudget;
  tokenCalibrationStore?: TokenCalibrationStore;
  adaptiveContextMode?: AdaptiveContextMode;
  /** Stage 2 is opt-in until the preference is wired through the main process. */
  assistantEvidenceProjectionMode?: AssistantEvidenceProjectionMode;
  evidenceCompressionMode?: EvidenceCompressionMode;
  modelCallCoordinator?: ModelCallCoordinatorType;
  /** Optional test/host injection; production defaults to the configured provider adapter. */
  evidenceCompressionDriver?: EvidenceCompressionDriver;
  evidenceCompressionCache?: EvidenceCompressionCache;
  /** Route override; production defaults to enforce and can roll back via env. */
  assistantContextRuntimeMode?: AssistantContextRuntimeMode;
  /** M5 L4 recall is projected as untrusted user data, never as a system rule. */
  longTermMemoryMaterial?: ContextMaterial;
  /** M6 is present only for persistent sessions with a ready L3 archive. */
  conversationSearch?: SearchConversationsToolRuntime;
}

function isAllRetrievedEvidenceEnabled(input: Pick<CurrentNoteAgentInput, 'assistantEvidenceProjectionMode'>): boolean {
  return input.assistantEvidenceProjectionMode === 'all-retrieved';
}

function isAllRetrievedCompressionEnforced(input: Pick<CurrentNoteAgentInput, 'assistantEvidenceProjectionMode' | 'evidenceCompressionMode'>): boolean {
  return input.assistantEvidenceProjectionMode === 'all-retrieved' && input.evidenceCompressionMode === 'enforce';
}

export function resolveCurrentNoteContextRuntimeMode(
  explicitMode?: AssistantContextRuntimeMode,
): AssistantContextRuntimeMode {
  const candidates = [
    explicitMode,
    process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_MODE,
    process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_MODE,
  ];
  for (const candidate of candidates) {
    if (candidate === 'off' || candidate === 'observe' || candidate === 'enforce') return candidate;
  }
  return 'enforce';
}

async function createCurrentNoteContextRuntime(input: CurrentNoteAgentInput): Promise<CurrentNoteContextRuntimeInput> {
  const budgets = resolveCurrentNoteMemoryBudgets(input.contextWindowTokens);
  const memoryAdapter = new CurrentNoteContextMemoryAdapter(input.conversation);
  const registry = new ContextMemoryRegistry(new ProjectContextAdapter(), [memoryAdapter]);
  const sessionId = input.memoryScopeKey.trim() || 'current-note-session';
  const memory = await registry.load({
    route: 'current-note',
    workspaceId: input.snapshot.libraryId,
    libraryId: input.snapshot.libraryId,
    noteId: input.snapshot.relativePath,
    sessionId,
    currentQuestion: input.question,
    snapshotId: input.snapshot.snapshotId,
    contentHash: input.snapshot.contentHash,
    budgets,
  });
  const longTermMemoryMaterial = input.longTermMemoryMaterial;
  const memoryWithLongTerm = longTermMemoryMaterial
    ? {
      ...memory,
      materials: [...memory.materials, longTermMemoryMaterial],
      version: `${memory.version}:l4:${longTermMemoryMaterial.id}`,
    }
    : memory;
  return {
    mode: resolveCurrentNoteContextRuntimeMode(input.assistantContextRuntimeMode),
    scope: {
      workspaceId: input.snapshot.libraryId,
      libraryId: input.snapshot.libraryId,
      noteId: input.snapshot.relativePath,
      sessionId,
    },
    windowProfile: resolveAssistantModelRuntimeProfile({
      providerId: input.providerKind,
      modelId: input.model,
      knownModelWindow: input.contextWindowTokens,
    }),
    memory: memoryWithLongTerm,
    stateVector: {
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      memoryVersion: memoryWithLongTerm.version,
    },
  };
}

function currentNotePromptRuntime(state: AgentState): CurrentNoteContextRuntimeInput {
  return {
    ...state.contextRuntime,
    stateVector: {
      ...state.contextRuntime.stateVector,
      ...(state.searchPlan?.planId ? { planId: state.searchPlan.planId } : {}),
    },
  };
}

function createCurrentNoteEvidenceLedger(input: CurrentNoteAgentInput, budget: CurrentNoteAgentBudget): CurrentNoteEvidenceLedger {
  const allRetrieved = isAllRetrievedEvidenceEnabled(input);
  return new CurrentNoteEvidenceLedger(
    input.snapshot,
    allRetrieved ? Number.MAX_SAFE_INTEGER : budget.maxRawEvidenceChars,
    {
      enforceRawEvidenceChars: !allRetrieved,
      ...(allRetrieved ? { maxSourceEvidenceRecords: input.snapshot.blocks.length + 2 * budget.maxToolCalls } : {}),
    },
  );
}

interface AgentState {
  startedAt: number;
  decisionRounds: number;
  modelCalls: number;
  toolCalls: number;
  invalidActionCount: number;
  noProgressCount: number;
  stopReason?: CurrentNoteAgentStats['stopReason'];
  actionProgress: Map<string, boolean>;
  searchResultSets: Set<string>;
  /** Counts every started current-note lexical search, including empty results. */
  searchAttemptCount: number;
  searchedBlocks: number;
  readCharacters: number;
  elapsedMs: number;
  searchPlan?: SearchPlan;
  searchScope?: CurrentNoteSearchScope;
  plannerOutputJson?: string;
  lastQueryTerms?: string[];
  coverageLedger: CurrentNoteSearchCoverageLedger;
  variantGates: Map<string, VariantGate>;
  userConfirmedTerms: Set<string>;
  modelVariantSearchGoals: Set<string>;
  modelVariantEvidenceIds: Set<string>;
  goalEvidenceIds: Map<string, Set<string>>;
  /** Per-evidence continuation state for bounded Decision-only source previews. */
  evidenceNextCursors: Map<string, number | null>;
  /** Normalized successful section reads that ended without a continuation cursor. */
  exhaustedSectionReadKeys: Set<string>;
  /** Only cursors emitted by a successful section read may continue that section. */
  sectionNextCursors: Map<string, number>;
  /** Only cursors emitted by a successful Plan search may continue that goal. */
  searchNextCursors: Map<string, string>;
  /** Zero-based start of the current deterministic QueryTerm batch for each goal. */
  searchTermBatchOffsets: Map<string, number>;
  modelCallGate: ModelCallBudgetGate;
  traceStore: PlanExecutionTraceStore;
  lastPromptPlan?: PromptBudgetPlan;
  lastPromptStats?: AssistantPromptStats;
  highestProjectionLevel: PromptProjectionLevel;
  lastActionFailureCode?: StructuredActionErrorCode;
  /** Safe local/schema violations used to make the next repair prompt actionable. */
  lastActionFailureDetails?: string[];
  decisionRepairCount: number;
  evidenceCompressionArtifacts: EvidenceCompressionArtifact[];
  evidenceCompressionRounds: number;
  evidenceCompressionBatchCount: number;
  evidenceCompressionCache: EvidenceCompressionCache;
  evidenceCompressionDriver?: EvidenceCompressionDriver;
  failedCompressionBatchIds: Set<string>;
  contextRuntime: CurrentNoteContextRuntimeInput;
  agentMessages: QaAgentMessageInput[];
  conversationSearchEnabled: boolean;
}

type VariantSignal = 'empty-search' | 'coverage-insufficient' | 'new-note-term';

interface VariantGate {
  signals: Set<VariantSignal>;
  noteMapTerms: Set<string>;
  searchObservationTerms: Set<string>;
}

type ValidatedToolAction =
  | { tool: 'get_note_map'; detail: CurrentNoteMapDetail }
  | { tool: 'search_note'; terms: string[]; limit: number; cursor?: string }
  | { tool: 'read_note_range'; lineFrom: number; lineTo: number }
  | { tool: 'read_note_section'; headingId: string; cursor?: number; cursorWasReset?: boolean }
  | { tool: 'expand_evidence'; evidenceId: string; beforeLines: number; afterLines: number }
  | { tool: 'search_conversations'; query: string; limit: number };

interface ToolObservation {
  summary: string;
  publicMessage: string;
  /** Full main-process tool result written only to the local detailed JSONL trace. */
  detailedOutput?: unknown;
  contentPreviews?: CurrentNotePublicToolContentPreview[];
  evidenceAdded: boolean;
  searchedBlocks: number;
  readCharacters: number;
  emptySearch: boolean;
  searchSet?: string;
  variantTerms?: { source: 'note-map' | 'search-observation'; terms: string[] };
  searchNextCursor?: string;
  candidateExhausted?: boolean;
  sectionHeadingId?: string;
  nextCursor?: number;
  evidenceId?: string;
}

/** A bounded, current-note-only ReAct runner. It never exposes private reasoning. */
export async function runCurrentNoteAgent(input: CurrentNoteAgentInput): Promise<CurrentNoteAgentResult> {
  const budget = input.budget ?? (isAllRetrievedCompressionEnforced(input) ? DEFAULT_ALL_RETRIEVED_TURN_BUDGET : DEFAULT_CURRENT_NOTE_AGENT_BUDGET);
  const toolCallsAlreadyUsed = input.toolCallsAlreadyUsed ?? 0;
  if (!Number.isInteger(toolCallsAlreadyUsed) || toolCallsAlreadyUsed < 0 || toolCallsAlreadyUsed > budget.maxToolCalls) {
    throw new Error(`已使用工具次数必须是 0 到 ${budget.maxToolCalls} 之间的整数。`);
  }
  const basePrompt = createCurrentNotePrompt({
    snapshot: input.snapshot,
    question: input.question,
    conversation: input.conversation,
    providerKind: input.providerKind,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    skillInstructions: input.skillInstructions,
  });
  const contextRuntime = await createCurrentNoteContextRuntime(input);
  const startedAt = Date.now();
  const fallbackScope = createFallbackCurrentNoteSearchScope(input.question);
  const state: AgentState = {
    startedAt,
    decisionRounds: 0,
    modelCalls: 0,
    toolCalls: toolCallsAlreadyUsed,
    invalidActionCount: 0,
    noProgressCount: 0,
    actionProgress: new Map(),
    searchResultSets: new Set(),
    searchAttemptCount: 0,
    searchedBlocks: 0,
    readCharacters: 0,
    elapsedMs: 0,
    searchScope: undefined,
    coverageLedger: new CurrentNoteSearchCoverageLedger(input.snapshot, fallbackScope),
    variantGates: new Map(),
    userConfirmedTerms: collectUserConfirmedTerms(input.question, input.conversation),
    modelVariantSearchGoals: new Set(),
    modelVariantEvidenceIds: new Set(),
    goalEvidenceIds: new Map(),
    evidenceNextCursors: new Map(),
    exhaustedSectionReadKeys: new Set(),
    sectionNextCursors: new Map(),
    searchNextCursors: new Map(),
    searchTermBatchOffsets: new Map(),
    modelCallGate: input.modelCallGate ?? new ModelCallBudgetGate({ maxModelCalls: budget.maxModelCalls, maxWallTimeMs: budget.maxWallTimeMs, startedAt }),
    traceStore: new PlanExecutionTraceStore(),
    highestProjectionLevel: 0,
    decisionRepairCount: 0,
    evidenceCompressionArtifacts: [],
    evidenceCompressionRounds: 0,
    evidenceCompressionBatchCount: 0,
    evidenceCompressionCache: input.evidenceCompressionCache ?? new EvidenceCompressionCache(),
    evidenceCompressionDriver: input.evidenceCompressionDriver,
    failedCompressionBatchIds: new Set(),
    contextRuntime,
    agentMessages: [],
    conversationSearchEnabled: Boolean(input.conversationSearch),
  };
  state.modelCalls = state.modelCallGate.modelCalls;
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) {
    state.stopReason = 'snapshot-stale';
    return finalize(input, basePrompt.prefixFingerprint, createCurrentNoteEvidenceLedger(input, budget), state,
      { type: 'answer', answer: '当前笔记已发生变化，请保存后重新提问。', citations: [], completeness: 'partial' }, 'react-search');
  }
  const ledger = createCurrentNoteEvidenceLedger(input, budget);
  const tools = createCurrentNoteTools(input.snapshot);
  const coverageJudge = new MemoryCoverageJudge(input.memory);
  const memoryEntry = coverageJudge.findCovered(input.memoryScopeKey, input.snapshot, input.question);
  if (memoryEntry) {
    const hydratedCount = hydrateMemoryEvidence(ledger, input.snapshot, memoryEntry.evidence);
    if (hydratedCount > 0) {
      for (const record of ledger.list()) state.coverageLedger.recordRead(undefined, toCoverageReadInput(record));
      const action = await synthesizeAnswer(input, basePrompt.stablePrefix, ledger, state, budget, 'memory-reuse');
      return finalize(input, basePrompt.prefixFingerprint, ledger, state, action, 'memory-reuse');
    }
  }

  if (input.planMode && input.planMode !== 'off' && input.planMode !== 'shadow-plan') {
    const planState = await initializeSearchPlan(input, basePrompt.capsule, state, budget, startedAt);
    if (planState === 'stale') {
      state.searchPlan = markPlanStale(state.searchPlan);
      emitPlanEvent(input, state, ledger, 'finished');
      return finalize(input, basePrompt.prefixFingerprint, ledger, state, {
        type: 'answer',
        answer: '当前笔记已发生变化，请保存后重新提问。',
        citations: [],
        completeness: 'partial',
      }, 'react-search', 'react-search', state.searchPlan);
    }
    if (planState === 'clarify') {
      return finalize(input, basePrompt.prefixFingerprint, ledger, state, {
        type: 'answer',
        answer: '请补充一个可定位当前笔记内容的关键词或具体问题。',
        citations: [],
        completeness: 'partial',
      }, 'react-search', 'clarify');
    }
    state.coverageLedger.adoptResolvedScope(state.searchScope ?? fallbackScope);
    emitPlanEvent(input, state, ledger, 'started');
  }

  let answerAction: Extract<CurrentNoteAgentAction, { type: 'answer' }> | undefined;
  let decisionAnswerAction: Extract<CurrentNoteAgentAction, { type: 'answer' }> | undefined;
  for (let iteration = 0; iteration < budget.maxDecisionRounds; iteration += 1) {
    const decisionStop = beforeDecision(input, state, budget, startedAt);
    if (decisionStop) {
      state.stopReason = decisionStop;
      break;
    }
    state.decisionRounds += 1;
    const decisionPrompt = composeDecisionPrompt(basePrompt.stablePrefix, input.question, input.conversation, ledger, state);
    const action = bindMissingPlanGoalId(
      await runCurrentNoteDecision(input, state, budget, decisionPrompt, basePrompt.stablePrefix, ledger),
      state.searchPlan,
      input.planMode,
    );
    if (!action) {
      if (state.stopReason === 'context-budget' || state.stopReason === 'timeout' || state.stopReason === 'max-model-calls') break;
      state.invalidActionCount += 1;
      if (state.invalidActionCount >= budget.maxInvalidActions) {
        state.stopReason = 'invalid-action';
        break;
      }
      continue;
    }
    if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    if (!input.isSnapshotCurrent()) {
      state.stopReason = 'snapshot-stale';
      break;
    }
    if (action.type === 'answer') {
      // Decide receives an evidence directory only. Once any raw evidence has
      // been read, route the user-visible answer through synthesis so it sees
      // the same evidence text the controller has already collected. The
      // model still controls when to stop searching. This presence check
      // only chooses a final-answer path that can see the collected raw text;
      // it neither judges evidence sufficiency nor rewrites the final answer.
      if (ledger.list().length === 0) {
        answerAction = action;
      } else {
        decisionAnswerAction = action;
        input.onDetailedTrace?.({
          stage: 'react-decision',
          action: 'decision-answer-routed-to-synthesis',
          status: 'completed',
          input: {
            terminationRequested: true,
            decisionCitationCount: action.citations.length,
            ledgerEvidenceCount: ledger.list().length,
          },
          output: {
            routedTo: 'synthesize',
            decisionPlanPatchPresent: action.planPatch !== undefined,
            decisionPlanPatchApplied: false,
            finalPlanPatchSource: 'synthesize',
          },
        });
      }
      state.stopReason = 'answered';
      break;
    }

    const toolStop = beforeTool(input, state, budget, startedAt);
    if (toolStop) {
      state.stopReason = toolStop;
      break;
    }
    let validated: ValidatedToolAction;
    let signature = '';
    try {
      const planSearchPagination = isPlanSearchPaginationEnabled(input.planMode);
      const executableAction = bindPlanSearchQueryTerms(action, state.searchPlan, input.planMode, state.searchTermBatchOffsets);
      const activeToolPhases = resolveCurrentNoteToolPhases(state, ledger);
      const toolIsActive = executableAction.tool === 'search_conversations'
        ? Boolean(input.conversationSearch)
        : isToolCapabilityActive(executableAction.tool, activeToolPhases);
      if (!toolIsActive) {
        throw new Error(`工具 ${executableAction.tool} 尚未在当前阶段激活。`);
      }
      signature = actionSignature(input.snapshot.snapshotId, executableAction);
      if (state.actionProgress.get(signature) === false) {
        state.stopReason = 'repeated-action';
        break;
      }
      validated = validateToolAction(
        executableAction,
        input.snapshot,
        state.sectionNextCursors,
        state.searchNextCursors,
        planSearchPagination,
        Boolean(input.conversationSearch),
      );
      const exhaustedReadKey = validated.tool === 'read_note_section'
        ? sectionReadExhaustionKey(input.snapshot.snapshotId, action.goalId, validated)
        : undefined;
      if (exhaustedReadKey && state.exhaustedSectionReadKeys.has(exhaustedReadKey)) {
        state.actionProgress.set(signature, false);
        state.noProgressCount += 1;
        state.stopReason = 'repeated-action';
        const evidenceIds = [...(state.goalEvidenceIds.get(action.goalId ?? state.searchPlan?.activeGoalId ?? '') ?? [])].slice(-2);
        recordExecutionTrace(state, 'correction', action.goalId ?? state.searchPlan?.activeGoalId, action.tool, '同一章节读取已成功完成且没有 nextCursor；已阻止无进展重复。', evidenceIds);
        emitTool(input, {
          tool: action.tool,
          state: 'rejected',
          message: '该章节已读取完成且没有后续游标，已跳过重复读取。',
          inputSummary: summarizeCurrentNoteToolInput(validated),
        });
        input.onDetailedTrace?.({
          stage: 'validation',
          action: 'skip-exhausted-section-read',
          status: 'rejected',
          input: {
            tool: action.tool,
            goalId: action.goalId ?? state.searchPlan?.activeGoalId,
            headingIdHash: sha256(validated.headingId),
            actionSignatureHash: sha256(signature),
          },
          output: { existingGoalEvidenceCount: evidenceIds.length, hasNextCursor: false },
          errorCode: 'repeated-action-no-progress',
        });
        break;
      }
      if (validated.tool === 'search_note') {
        state.lastQueryTerms = planSearchPagination ? stableOrderedTerms(validated.terms) : sanitizeQueryTerms(validated.terms);
      }
      if (planSearchPagination) {
        if (!state.searchPlan) throw new Error('当前计划不存在。');
        state.searchPlan = preparePlanForTool(state.searchPlan, action, ledger, state, input.snapshot.contentHash);
        emitPlanEvent(input, state, ledger, 'updated');
      }
    } catch (error) {
      input.onDetailedTrace?.({
        stage: 'validation',
        action: `tool-action-${action.tool}`,
        status: 'rejected',
        input: action,
        errorCode: /plan|patch|补丁|计划/u.test(error instanceof Error ? error.message : '') ? 'invalid-plan-patch' : 'invalid-tool-arguments',
        error: toDetailedTraceError(error),
      });
      registerInvalidToolAction(input, state, budget, action.tool, error);
      if (state.stopReason) break;
      continue;
    }
    const toolCallId = `tool-${state.toolCalls + 1}`;
    state.toolCalls += 1;
    state.agentMessages.push({
      role: 'assistant',
      content: action.publicRationale,
      toolCalls: [{
        callId: toolCallId,
        toolName: validated.tool,
        arguments: toQaAgentToolArguments(validated),
      }],
    });
    if (validated.tool === 'search_note') state.searchAttemptCount += 1;
    recordExecutionTrace(state, 'action', action.goalId ?? state.searchPlan?.activeGoalId, action.tool, `已请求工具 ${action.tool}`, []);
    const inputSummary = summarizeCurrentNoteToolInput(validated);
    emitTool(input, { tool: action.tool, state: 'started', message: action.publicRationale, inputSummary });
    input.onDetailedTrace?.({ stage: 'react-tool', action: action.tool, status: 'started', input: validated });
    const toolStartedAt = Date.now();
    try {
      const activeGoalId = input.planMode && input.planMode !== 'off' && input.planMode !== 'shadow-plan' ? state.searchPlan?.activeGoalId : undefined;
      if (validated.tool === 'search_note' && activeGoalId) {
        state.modelVariantSearchGoals.delete(activeGoalId);
        if (hasModelVariantQuery(state.searchPlan, activeGoalId, validated.terms)) {
          state.modelVariantSearchGoals.add(activeGoalId);
        }
      }
      const evidenceIdsBeforeTool = new Set(ledger.list().map((record) => record.evidenceId));
      const planSearchPagination = isPlanSearchPaginationEnabled(input.planMode);
      const plannedQueryTerms = state.searchPlan && action.goalId
        ? collectStableSearchGoalQueryTerms(state.searchPlan, action.goalId)
        : undefined;
      const observation = validated.tool === 'search_conversations'
        ? await executeConversationSearchTool(validated, input.conversationSearch)
        : executeTool(validated, tools, input.snapshot, ledger, toolCallId, input.question, budget, computeInternalReadLimits(input, state, budget), state.searchScope, state.coverageLedger, action.goalId, planSearchPagination, isAllRetrievedEvidenceEnabled(input), plannedQueryTerms);
      state.agentMessages.push({
        role: 'tool',
        toolCallId,
        toolName: validated.tool,
        content: observation.summary.trim() || observation.publicMessage.trim() || '工具调用已完成。',
      });
      const elapsedMs = Date.now() - toolStartedAt;
      if (observation.sectionHeadingId) {
        if (observation.nextCursor !== undefined) state.sectionNextCursors.set(observation.sectionHeadingId, observation.nextCursor);
        else state.sectionNextCursors.delete(observation.sectionHeadingId);
      }
      if (validated.tool === 'search_note' && planSearchPagination) {
        const searchCursorKey = normalizeSearchCursorKey(action.goalId);
        if (observation.searchNextCursor !== undefined) state.searchNextCursors.set(searchCursorKey, observation.searchNextCursor);
        else state.searchNextCursors.delete(searchCursorKey);
        if (observation.candidateExhausted && observation.searchNextCursor === undefined) {
          const currentOffset = state.searchTermBatchOffsets.get(searchCursorKey) ?? 0;
          state.searchTermBatchOffsets.set(searchCursorKey, currentOffset + validated.terms.length);
        }
      }
      state.elapsedMs += elapsedMs;
      state.searchedBlocks += observation.searchedBlocks;
      state.readCharacters += observation.readCharacters;
      state.actionProgress.set(signature, observation.evidenceAdded);
      if (validated.tool === 'read_note_section' && observation.nextCursor === undefined) {
        state.exhaustedSectionReadKeys.add(sectionReadExhaustionKey(input.snapshot.snapshotId, action.goalId, validated));
      }
      emitTool(input, {
        tool: action.tool,
        state: 'completed',
        message: observation.publicMessage,
        inputSummary,
        outputSummary: observation.publicMessage,
        ...(observation.contentPreviews?.length ? { contentPreviews: observation.contentPreviews } : {}),
        elapsedMs,
      });
      input.onDetailedTrace?.({
        stage: 'react-tool',
        action: action.tool,
        status: 'completed',
        input: validated,
        output: observation.detailedOutput ?? observation,
        elapsedMs,
      });
      recordGoalEvidence(state, action.goalId, evidenceIdsBeforeTool, ledger);
      recordLatestEvidenceObservation(state, action.goalId, validated, observation);
      recordExecutionTrace(state, 'observation', action.goalId ?? state.searchPlan?.activeGoalId, action.tool, observation.summary, [...ledger.list().map((record) => record.evidenceId)].filter((evidenceId) => !evidenceIdsBeforeTool.has(evidenceId)));
      recordVariantSignals(state, state.searchPlan, action.goalId, observation, evidenceIdsBeforeTool, ledger);
      emitPlanEvent(input, state, ledger, 'updated');
      recordProgress(state, observation, budget);
      if (!input.isSnapshotCurrent()) {
        state.stopReason = 'snapshot-stale';
        break;
      }
      if (state.stopReason) break;
    } catch (error) {
      const elapsedMs = Date.now() - toolStartedAt;
      const errorMessage = error instanceof Error ? error.message : '工具执行失败。';
      state.agentMessages.push({
        role: 'tool',
        toolCallId,
        toolName: validated.tool,
        content: `工具执行失败：${errorMessage}`,
      });
      state.elapsedMs += elapsedMs;
      state.actionProgress.set(signature, false);
      state.noProgressCount += 1;
      state.invalidActionCount += 1;
      recordExecutionTrace(state, 'correction', action.goalId ?? state.searchPlan?.activeGoalId, action.tool, `工具 ${action.tool} 执行失败；请根据参数约束重试。`, []);
      emitTool(input, { tool: action.tool, state: 'rejected', message: errorMessage, inputSummary, elapsedMs });
      input.onDetailedTrace?.({
        stage: 'react-tool',
        action: action.tool,
        status: 'rejected',
        input: validated,
        errorCode: 'tool-execution-error',
        error: toDetailedTraceError(error),
        elapsedMs,
      });
      if (state.invalidActionCount >= budget.maxInvalidActions) {
        state.stopReason = 'invalid-action';
        break;
      }
      if (state.noProgressCount >= budget.maxNoProgressRounds) {
        state.stopReason = 'no-progress';
        break;
      }
    }
  }

  state.stopReason ??= state.toolCalls >= budget.maxToolCalls ? 'max-tool-calls' : 'max-decision-rounds';
  const synthesisGoalId = state.searchPlan?.activeGoalId;
  const candidateEvidenceIds = resolveGoalSynthesisCandidateEvidenceIds(
    state,
    ledger,
    input.snapshot.snapshotId,
    input.snapshot.contentHash,
    { decisionAction: decisionAnswerAction },
  );
  emitGoalSynthesisEvidenceAdmissionTrace(input, state, ledger, candidateEvidenceIds);
  const finalAction = answerAction ?? await synthesizeAnswer(
    input,
    basePrompt.stablePrefix,
    ledger,
    state,
    budget,
    'react-search',
    candidateEvidenceIds.length > 0 ? { candidateEvidenceIds } : {},
  );
  let planFinalization: ModelAnswerPlanFinalization | undefined;
  if (input.planMode && input.planMode !== 'off' && input.planMode !== 'shadow-plan' && state.searchPlan) {
    if (state.stopReason === 'snapshot-stale') {
      state.searchPlan = markPlanStale(state.searchPlan);
    } else {
      planFinalization = finalizePlanFromModelAnswer(state, finalAction, ledger, isAllRetrievedCompressionEnforced(input));
      input.onDetailedTrace?.({
        stage: 'plan-commit',
        action: 'mirror-model-answer-to-plan',
        status: 'completed',
        input: finalAction,
        output: planFinalization,
      });
    }
  }
  emitFinalEvidenceAdmissionTrace(input, state, ledger, synthesisGoalId, candidateEvidenceIds, finalAction, planFinalization);
  emitPlanEvent(input, state, ledger, 'finished');
  return finalize(input, basePrompt.prefixFingerprint, ledger, state, finalAction, 'react-search', 'react-search', state.searchPlan);
}

type SearchPlanInitialization = 'ready' | 'clarify' | 'stale';

async function initializeSearchPlan(
  input: CurrentNoteAgentInput,
  capsule: NonNullable<ReturnType<typeof createCurrentNotePrompt>['capsule']> | undefined,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  startedAt: number,
): Promise<SearchPlanInitialization> {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) {
    state.stopReason = 'snapshot-stale';
    return 'stale';
  }
  // A last model call belongs to synthesis. If there is no room for one
  // planner call plus synthesis, create only the local fallback plan.
  if (budget.maxModelCalls - state.modelCalls <= 1) {
    const fallback = createFallbackCurrentNotePlanResult(input.question);
    state.searchPlan = fallback?.plan;
    state.searchScope = fallback?.scope ?? createFallbackCurrentNoteSearchScope(input.question);
    return state.searchPlan ? 'ready' : 'clarify';
  }

  state.decisionRounds += 1;
  if (!capsule) {
    const fallback = createFallbackCurrentNotePlanResult(input.question);
    state.searchPlan = fallback?.plan;
    state.searchScope = fallback?.scope ?? createFallbackCurrentNoteSearchScope(input.question);
    return state.searchPlan ? 'ready' : 'clarify';
  }
  const plannerInput = {
    capsule,
    question: input.question,
    conversation: input.conversation,
    signal: input.signal,
  };
  let plannerProjection: PromptProjection | undefined;
  createCurrentNotePlanPrompt(plannerInput, (sections) => {
    plannerProjection = new PlanAwarePromptProjector(state.traceStore).build({
      callKind: 'plan',
      stablePrefix: sections.policy,
      capsuleText: sections.capsuleText,
      question: sections.question,
      conversation: sections.conversation,
      toolInstructions: sections.toolInstructions,
      outputSchema: DEFAULT_PLAN_JSON_SCHEMA,
      contextRuntime: currentNotePromptRuntime(state),
    });
    return plannerProjection.prompt;
  });
  if (!plannerProjection) throw new Error('current-note Planner Prompt 组装失败。');
  const plannerPrompt = plannerProjection.prompt;
  const plannerStartedAt = Date.now();
  try {
    if (!input.planner) throw new Error('current-note Planner 未配置。');
    const planned = await runCurrentNotePlan(input, state, budget, plannerProjection, plannerInput);
    state.searchPlan = planned?.plan;
    state.searchScope = planned?.scope;
    state.plannerOutputJson = planned?.plannerOutputJson || undefined;
    input.onDetailedTrace?.({
      stage: 'validation',
      action: 'planner-search-plan-validation',
      status: planned?.plan ? 'completed' : 'rejected',
      input: { prompt: plannerPrompt },
      output: planned ?? { accepted: false },
      ...(!planned?.plan ? { errorCode: 'invalid-planner-output' } : {}),
      elapsedMs: Date.now() - plannerStartedAt,
    });
    if (!state.searchPlan) {
      const fallback = createFallbackCurrentNotePlanResult(input.question);
      state.searchPlan = fallback?.plan;
      state.searchScope = fallback?.scope ?? createFallbackCurrentNoteSearchScope(input.question);
      input.onDetailedTrace?.({
        stage: 'fallback',
        action: 'local-fallback-search-plan',
        status: state.searchPlan ? 'completed' : 'rejected',
        input: { question: input.question },
        output: state.searchPlan ?? { accepted: false },
      });
    }
  } catch (error) {
    input.onDetailedTrace?.({
      stage: 'validation',
      action: 'planner-search-plan-validation',
      status: 'rejected',
      input: { prompt: plannerPrompt },
      errorCode: isAiContextOverflow(error) ? 'context-overflow' : 'invalid-planner-output',
      error: toDetailedTraceError(error),
      elapsedMs: Date.now() - plannerStartedAt,
    });
    if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    state.invalidActionCount += 1;
    if (isAiContextOverflow(error)) state.stopReason = 'context-budget';
    const fallback = createFallbackCurrentNotePlanResult(input.question);
    state.searchPlan = fallback?.plan;
    state.searchScope = fallback?.scope ?? createFallbackCurrentNoteSearchScope(input.question);
    input.onDetailedTrace?.({
      stage: 'fallback',
      action: 'local-fallback-search-plan',
      status: state.searchPlan ? 'completed' : 'rejected',
      input: { question: input.question },
      output: state.searchPlan ?? { accepted: false },
    });
  }
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) {
    state.stopReason = 'snapshot-stale';
    return 'stale';
  }
  if (hasWallTimeExpired(budget, startedAt)) {
    state.stopReason = 'timeout';
  }
  return state.searchPlan ? 'ready' : 'clarify';
}

function preparePlanForTool(
  plan: SearchPlan,
  action: Extract<CurrentNoteAgentAction, { type: 'tool' }>,
  ledger: CurrentNoteEvidenceLedger,
  state: AgentState,
  contentHash: string,
): SearchPlan {
  let nextPlan = plan;
  const evidenceIds = new Set(ledger.list().map((record) => record.evidenceId));
  if (action.planPatch !== undefined && (action.tool === 'get_note_map' || action.tool === 'search_note')) {
    if (action.planPatch.goalUpdates.some((update) => update.status === 'partial' || update.status === 'covered' || update.status === 'conflicted')) {
      throw new Error('地图和搜索工具只产生导航观察，不能直接改变目标覆盖状态。');
    }
  }
  const variantUpdates = action.planPatch?.goalUpdates.filter((update) => (update.queryVariants?.length ?? 0) > 0) ?? [];
  if (variantUpdates.length > 0) {
    for (const update of variantUpdates) {
      const currentGoal = plan.goals.find((goal) => goal.goalId === update.goalId);
      if (!currentGoal) throw new Error(`queryVariant 引用了不存在的 goalId：${update.goalId}。`);
      if (currentGoal.status === 'partial' || currentGoal.status === 'conflicted' || currentGoal.status === 'not-found') {
        getVariantGate(state, currentGoal.goalId).signals.add('coverage-insufficient');
      }
      const gate = getVariantGate(state, currentGoal.goalId);
      if (gate.signals.size === 0) throw new Error('当前没有搜索为空、覆盖不足或新标题/术语观察，不能追加 queryVariant。');
      for (const variant of update.queryVariants ?? []) {
        assertControllerVariantSource(variant.term, variant.source, gate, state.userConfirmedTerms);
      }
    }
  }
  if (action.planPatch !== undefined) {
    for (const update of action.planPatch.goalUpdates) {
      if (update.status === 'partial') {
        const hasGoalEvidence = [...(state.goalEvidenceIds.get(update.goalId) ?? [])]
          .some((evidenceId) => ledger.get(evidenceId)?.contentHash === contentHash);
        if (!hasGoalEvidence) throw new Error('当前目标尚无原文读取，不能由模型 patch 提交 partial。');
      }
    }
    const patched = applyModelSearchPlanPatch(nextPlan, action.planPatch, {
      evidenceIds,
      queryVariantScope: buildVariantScope(state),
    });
    if (!patched.ok) throw new Error(`计划补丁被拒绝：${patched.message}`);
    nextPlan = patched.plan;
    assertPlanStatusesHaveReadEvidence(nextPlan, evidenceIds);
    for (const update of action.planPatch.goalUpdates) {
      if (update.status !== 'covered' && update.status !== 'conflicted') continue;
      const goal = nextPlan.goals.find((candidate) => candidate.goalId === update.goalId);
      if (!goal) throw new Error(`计划补丁引用了不存在的目标：${update.goalId}。`);
      validateGoalRequirementCoverage(goal, ledger, contentHash);
    }
    for (const update of variantUpdates) getVariantGate(state, update.goalId).signals.clear();
  }
  if (nextPlan.status !== 'active') throw new Error('当前计划已终止，不能继续执行工具。');
  if (!action.goalId) throw new Error('计划模式下工具动作必须包含 goalId。');
  if (nextPlan.activeGoalId !== action.goalId) throw new Error('工具动作 goalId 必须等于当前 activeGoalId。');
  const activeGoal = nextPlan.goals.find((goal) => goal.goalId === action.goalId);
  if (!activeGoal || !isSearchGoalExecutable(activeGoal.status)) throw new Error('当前 activeGoal 不可执行。');
  if (activeGoal.status === 'pending') {
    const started = applySearchPlanPatch(nextPlan, {
      baseVersion: nextPlan.version,
      goalUpdates: [{ goalId: activeGoal.goalId, status: 'searching' }],
    }, { evidenceIds });
    if (!started.ok) throw new Error(`目标启动补丁被拒绝：${started.message}`);
    nextPlan = started.plan;
  }
  return nextPlan;
}

function assertPlanStatusesHaveReadEvidence(plan: SearchPlan, evidenceIds: ReadonlySet<string>): void {
  for (const goal of plan.goals) {
    if (goal.status !== 'partial') continue;
    const boundEvidenceIds = new Set([
      ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
      ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
    ]);
    if (![...boundEvidenceIds].some((evidenceId) => evidenceIds.has(evidenceId))) {
      throw new Error(`目标 ${goal.goalId} 尚无原文证据，不能标记为 partial。`);
    }
  }
}

function getVariantGate(state: AgentState, goalId: string): VariantGate {
  const existing = state.variantGates.get(goalId);
  if (existing) return existing;
  const gate: VariantGate = { signals: new Set(), noteMapTerms: new Set(), searchObservationTerms: new Set() };
  state.variantGates.set(goalId, gate);
  return gate;
}

function assertControllerVariantSource(
  term: string,
  source: QueryVariant['source'],
  gate: VariantGate,
  userConfirmedTerms: ReadonlySet<string>,
): void {
  const normalized = normalizeVariantTerm(term);
  const proven = source === 'model-synonym'
    || source === 'note-map' && gate.noteMapTerms.has(normalized)
    || source === 'search-observation' && gate.searchObservationTerms.has(normalized)
    || source === 'user-confirmed' && userConfirmedTerms.has(normalized);
  if (!proven) throw new Error(`queryVariant ${normalized} 的 source=${source} 无法由当前作用域证明。`);
}

function buildVariantScope(state: AgentState): {
  noteMapTerms: string[];
  searchObservationTerms: string[];
  userConfirmedTerms: string[];
} {
  const noteMapTerms = new Set<string>();
  const searchObservationTerms = new Set<string>();
  for (const gate of state.variantGates.values()) {
    for (const term of gate.noteMapTerms) noteMapTerms.add(term);
    for (const term of gate.searchObservationTerms) searchObservationTerms.add(term);
  }
  return {
    noteMapTerms: [...noteMapTerms],
    searchObservationTerms: [...searchObservationTerms],
    userConfirmedTerms: [...state.userConfirmedTerms],
  };
}

function collectUserConfirmedTerms(question: string, conversation: AssistantConversationMessage[]): Set<string> {
  return collectScopeTerms([
    question,
    ...conversation.filter((message) => message.role === 'user').map((message) => message.content),
  ]);
}

function collectScopeTerms(values: readonly string[]): Set<string> {
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = normalizeVariantTerm(value);
    if (normalized.length >= 2) terms.add(normalized);
    for (const term of tokenizeCurrentNoteText(value)) {
      const normalizedTerm = normalizeVariantTerm(term);
      if (normalizedTerm.length >= 2) terms.add(normalizedTerm);
    }
  }
  return terms;
}

function normalizeVariantTerm(value: string): string {
  return normalizeTechnicalTerm(value).replace(/\s+/gu, '');
}

function hasModelVariantQuery(plan: SearchPlan | undefined, goalId: string, terms: readonly string[]): boolean {
  const goal = plan?.goals.find((candidate) => candidate.goalId === goalId);
  if (!goal) return false;
  const queryTerms = new Set(terms.map(normalizeVariantTerm));
  return goal.queryTerms.some((queryTerm) => queryTerm.source === 'model-synonym' && queryTerms.has(normalizeVariantTerm(queryTerm.term)));
}

function recordGoalEvidence(
  state: AgentState,
  goalId: string | undefined,
  evidenceIdsBeforeTool: ReadonlySet<string>,
  ledger: CurrentNoteEvidenceLedger,
): void {
  if (!goalId) return;
  const newEvidenceIds = ledger.list()
    .map((record) => record.evidenceId)
    .filter((evidenceId) => !evidenceIdsBeforeTool.has(evidenceId));
  assignGoalEvidence(state, goalId, newEvidenceIds);
}

function assignGoalEvidence(state: AgentState, goalId: string | undefined, evidenceIds: readonly string[]): void {
  if (!goalId || !evidenceIds.length) return;
  const goalEvidence = state.goalEvidenceIds.get(goalId) ?? new Set<string>();
  for (const evidenceId of evidenceIds) goalEvidence.add(evidenceId);
  state.goalEvidenceIds.set(goalId, goalEvidence);
}

function recordLatestEvidenceObservation(
  state: AgentState,
  goalId: string | undefined,
  action: ValidatedToolAction,
  observation: ToolObservation,
): void {
  if (!goalId || !observation.evidenceId) return;
  if (action.tool !== 'read_note_section' && action.tool !== 'read_note_range' && action.tool !== 'expand_evidence') return;
  assignGoalEvidence(state, goalId, [observation.evidenceId]);
  state.evidenceNextCursors.set(
    observation.evidenceId,
    action.tool === 'read_note_section' ? observation.nextCursor ?? null : null,
  );
}

function resolveCurrentGoalLatestEvidenceObservations(
  state: AgentState,
  ledger: CurrentNoteEvidenceLedger,
): readonly LatestEvidenceObservation[] {
  const activeGoalId = state.searchPlan?.activeGoalId;
  if (!activeGoalId) return [];
  const records = [...(state.goalEvidenceIds.get(activeGoalId) ?? [])]
    .map((evidenceId) => ledger.get(evidenceId))
    .filter((record): record is CurrentNoteEvidenceRecord => Boolean(record))
    .filter((record) => record.admission === 'explicit-read'
      || record.admission === 'expanded-read'
      || record.admissions.some((admission) => admission === 'explicit-read' || admission === 'expanded-read'))
    .sort((first, second) => first.firstSeenSeq - second.firstSeenSeq)
    .slice(-2);
  return records.map((record) => {
    const nextCursor = state.evidenceNextCursors.get(record.evidenceId);
    return {
      goalId: activeGoalId,
      evidenceId: record.evidenceId,
      hasNextCursor: typeof nextCursor === 'number',
      ...(typeof nextCursor === 'number' ? { nextCursor } : {}),
    };
  });
}

function sectionReadExhaustionKey(
  snapshotId: string,
  goalId: string | undefined,
  action: Extract<ValidatedToolAction, { tool: 'read_note_section' }>,
): string {
  return sha256(`${snapshotId}\u0000${goalId ?? ''}\u0000${action.headingId}\u0000${action.cursor ?? 'start'}`);
}

interface GoalSynthesisCandidateOptions {
  explicitCandidateEvidenceIds?: readonly string[];
  decisionAction?: Extract<CurrentNoteAgentAction, { type: 'answer' }>;
}

/**
 * Resolves current-goal source candidates without promoting them to plan
 * evidence bindings. Ledger order is normalized back to first admission order
 * so repeated reads cannot reorder the final synthesis context.
 */
function resolveGoalSynthesisCandidateEvidenceIds(
  state: AgentState,
  ledger: CurrentNoteEvidenceLedger,
  snapshotId: string,
  contentHash: string,
  options: GoalSynthesisCandidateOptions = {},
): readonly string[] {
  const activeGoalId = state.searchPlan?.activeGoalId;
  if (!activeGoalId) return [];
  const goalEvidenceIds = state.goalEvidenceIds.get(activeGoalId);
  if (!goalEvidenceIds?.size) return [];

  const requestedEvidenceIds = new Set([
    ...(options.explicitCandidateEvidenceIds ?? []),
    ...(options.decisionAction?.citations ?? []),
    ...goalEvidenceIds,
  ]);
  return ledger.list()
    .filter((record) => record.snapshotId === snapshotId && record.contentHash === contentHash)
    .filter((record) => goalEvidenceIds.has(record.evidenceId) && requestedEvidenceIds.has(record.evidenceId))
    .sort((first, second) => first.firstSeenSeq - second.firstSeenSeq)
    .map((record) => record.evidenceId);
}

function emitGoalSynthesisEvidenceAdmissionTrace(
  input: CurrentNoteAgentInput,
  state: AgentState,
  ledger: CurrentNoteEvidenceLedger,
  selectedEvidenceIds: readonly string[],
): void {
  const activeGoalId = state.searchPlan?.activeGoalId;
  if (!activeGoalId) return;
  const ledgerEvidenceCount = ledger.list().length;
  const goalEvidenceCount = state.goalEvidenceIds.get(activeGoalId)?.size ?? 0;
  const coverage = coverageSummaryForGoal(state, activeGoalId);
  const readEvidenceCount = coverage.evidenceCount;
  const admissionEmpty = readEvidenceCount > 0 && selectedEvidenceIds.length === 0;
  input.onDetailedTrace?.({
    stage: 'validation',
    action: 'resolve-goal-synthesis-candidates',
    status: admissionEmpty ? 'rejected' : 'completed',
    input: {
      ledgerEvidenceCount,
      goalEvidenceCount,
      discoveredCandidateCount: coverage.matchedBlockCount,
      readEvidenceCount,
      coverageStatus: coverage.status,
      candidateTruncated: coverage.candidateTruncated,
    },
    output: {
      candidateEvidenceCount: selectedEvidenceIds.length,
      selectedEvidenceCount: selectedEvidenceIds.length,
      evidenceHashes: selectedEvidenceIds.map(sha256),
      admissionStatus: admissionEmpty
        ? 'empty-after-read'
        : selectedEvidenceIds.length > 0
          ? 'selected'
          : 'not-read',
      selectionReason: admissionEmpty
        ? 'evidence-admission-empty'
        : selectedEvidenceIds.length > 0
          ? 'current-goal-evidence'
          : 'current-goal-has-no-evidence',
    },
    ...(admissionEmpty ? { errorCode: 'evidence-admission-empty' } : {}),
  });
}

function emitFinalEvidenceAdmissionTrace(
  input: CurrentNoteAgentInput,
  state: AgentState,
  ledger: CurrentNoteEvidenceLedger,
  synthesisGoalId: string | null | undefined,
  selectedEvidenceIds: readonly string[],
  action: Extract<CurrentNoteAgentAction, { type: 'answer' }>,
  planFinalization: ModelAnswerPlanFinalization | undefined,
): void {
  const coverage = synthesisGoalId
    ? coverageSummaryForGoal(state, synthesisGoalId)
    : state.coverageLedger.toSummary(1);
  const ledgerEvidenceIds = new Set(ledger.list().map((record) => record.evidenceId));
  const selected = [...new Set(selectedEvidenceIds)].filter((evidenceId) => ledgerEvidenceIds.has(evidenceId));
  const cited = [...new Set(action.citations)].filter((evidenceId) => ledgerEvidenceIds.has(evidenceId));
  const admissionEmpty = coverage.evidenceCount > 0 && selected.length === 0;
  const terminalGoalMismatch = Boolean(
    state.searchPlan
    && state.searchPlan.status !== 'active'
    && state.searchPlan.status !== 'stale'
    && state.searchPlan.goals.some((goal) => goal.status === 'pending' || goal.status === 'searching'),
  );
  const finalState = admissionEmpty
    ? 'admission-empty-after-read'
    : terminalGoalMismatch
      ? 'terminal-plan-has-executable-goal'
      : action.completeness === 'complete' && state.searchPlan && state.searchPlan.status !== 'completed'
        ? 'answer-complete-plan-not-completed'
        : action.completeness === 'not-found'
          ? 'model-not-found'
          : 'consistent';
  input.onDetailedTrace?.({
    stage: 'validation',
    action: 'final-evidence-admission-state',
    status: admissionEmpty || terminalGoalMismatch ? 'rejected' : 'completed',
    input: {
      coverageStatus: coverage.status,
      candidateTruncated: coverage.candidateTruncated,
      discoveredCandidateCount: coverage.matchedBlockCount,
      readEvidenceCount: coverage.evidenceCount,
    },
    output: {
      selectedEvidenceCount: selected.length,
      citedEvidenceCount: cited.length,
      selectedEvidenceHashes: selected.map(sha256),
      citedEvidenceHashes: cited.map(sha256),
      admissionStatus: admissionEmpty ? 'empty-after-read' : selected.length > 0 ? 'selected' : 'not-read',
      completeness: action.completeness,
      planStatus: state.searchPlan?.status,
      goalStatuses: state.searchPlan?.goals.map((goal) => goal.status) ?? [],
      planPatchProvided: planFinalization?.planPatchProvided ?? Boolean(action.planPatch),
      planPatchApplied: planFinalization?.planPatchApplied ?? false,
      finalState,
    },
    ...(admissionEmpty
      ? { errorCode: 'evidence-admission-empty' }
      : terminalGoalMismatch
        ? { errorCode: 'terminal-plan-goal-mismatch' }
        : {}),
  });
}

function coverageEvidenceTargetForGoal(state: AgentState, goalId: string | undefined, relaxRequirementMinEvidence = false): number {
  if (!goalId) return 1;
  const goal = state.searchPlan?.goals.find((candidate) => candidate.goalId === goalId);
  if (!goal) return 1;
  if (relaxRequirementMinEvidence) return 1;
  return Math.max(1, goal.requirements.reduce((total, requirement) => total + requirement.minEvidence, 0));
}

function coverageSummaryForGoal(state: AgentState, goalId?: string, relaxRequirementMinEvidence = false): CurrentNoteSearchCoverageSummary {
  const requiredEvidence = coverageEvidenceTargetForGoal(state, goalId, relaxRequirementMinEvidence);
  const summary = state.coverageLedger.toModelSummary(goalId, requiredEvidence);
  return Object.freeze({ ...summary, goalSummaries: Object.freeze([summary]) });
}

/**
 * Tool-time SearchPlan patches remain scoped to records read from the current
 * note. This protects plan state only; it never accepts, rejects or rewrites a
 * model answer.
 */
function validateGoalRequirementCoverage(
  goal: SearchGoal,
  ledger: CurrentNoteEvidenceLedger,
  contentHash: string,
  relaxRequirementMinEvidence = false,
): void {
  const evidenceFor = (evidenceIds: readonly string[], label: string): Set<string> => {
    const valid = new Set<string>();
    for (const evidenceId of evidenceIds) {
      const record = ledger.get(evidenceId);
      if (!record || record.contentHash !== contentHash) {
        throw new Error(`${label} 引用了不属于当前笔记原文账本的证据。`);
      }
      valid.add(evidenceId);
    }
    return valid;
  };

  if (goal.status === 'covered') {
    const bindings = new Map(goal.evidenceBindings.map((binding) => [binding.requirementId, binding]));
    const requirementEvidence = new Map<string, Set<string>>();
    for (const requirement of goal.requirements) {
      const binding = bindings.get(requirement.requirementId);
      if (!binding) throw new Error(`requirement ${requirement.requirementId} 缺少原文证据绑定。`);
      const validEvidence = evidenceFor(binding.evidenceIds, `requirement ${requirement.requirementId}`);
      const requiredEvidence = relaxRequirementMinEvidence ? 1 : requirement.minEvidence;
      if (validEvidence.size < requiredEvidence) {
        throw new Error(`requirement ${requirement.requirementId} 的有效原文证据未达到当前完成门槛。`);
      }
      requirementEvidence.set(requirement.requirementId, validEvidence);
    }
    if (goal.evidenceKind === 'comparison') {
      const subjectRequirements = goal.requirements.filter((requirement) => requirement.subject?.trim());
      for (let firstIndex = 0; firstIndex < subjectRequirements.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < subjectRequirements.length; secondIndex += 1) {
          const first = subjectRequirements[firstIndex];
          const second = subjectRequirements[secondIndex];
          if (normalizeVariantTerm(first.subject ?? '') === normalizeVariantTerm(second.subject ?? '')) continue;
          const firstEvidence = requirementEvidence.get(first.requirementId) ?? new Set<string>();
          const secondEvidence = requirementEvidence.get(second.requirementId) ?? new Set<string>();
          const firstHasIndependentEvidence = [...firstEvidence].some((evidenceId) => !secondEvidence.has(evidenceId));
          const secondHasIndependentEvidence = [...secondEvidence].some((evidenceId) => !firstEvidence.has(evidenceId));
          if (!firstHasIndependentEvidence || !secondHasIndependentEvidence) {
            throw new Error(`comparison 的 subject ${first.subject} 与 ${second.subject} 必须分别绑定独立原文证据。`);
          }
        }
      }
    }
    return;
  }

  if (goal.status === 'conflicted') {
    const conflicts = new Map(goal.conflictBindings.map((binding) => [binding.requirementId, binding]));
    for (const requirement of goal.requirements) {
      const binding = conflicts.get(requirement.requirementId);
      if (!binding) throw new Error(`conflict requirement ${requirement.requirementId} 缺少双侧原文证据绑定。`);
      const supports = evidenceFor(binding.supportsEvidenceIds, `conflict requirement ${requirement.requirementId} 的支持侧`);
      const contradicts = evidenceFor(binding.contradictsEvidenceIds, `conflict requirement ${requirement.requirementId} 的反对侧`);
      const requiredEvidence = relaxRequirementMinEvidence ? 1 : requirement.minEvidence;
      if (supports.size < requiredEvidence || contradicts.size < requiredEvidence) {
        throw new Error(`conflict requirement ${requirement.requirementId} 的支持侧和反对侧都必须达到当前完成门槛。`);
      }
    }
  }
}

function emitPlanEvent(
  input: CurrentNoteAgentInput,
  state: AgentState,
  ledger: CurrentNoteEvidenceLedger,
  phase: CurrentNotePublicPlanEvent['phase'],
): void {
  const plan = state.searchPlan;
  if (!plan) return;
  const ledgerEvidenceIds = new Set(ledger.list().map((record) => record.evidenceId));
  if (input.onPlanEvent) {
    input.onPlanEvent({
      phase,
      status: plan.status,
      goals: plan.goals.map((goal) => {
        const evidenceIds = new Set(state.goalEvidenceIds.get(goal.goalId) ?? []);
        for (const evidenceId of goal.evidenceBindings.flatMap((binding) => binding.evidenceIds)) evidenceIds.add(evidenceId);
        for (const binding of goal.conflictBindings) {
          for (const evidenceId of binding.supportsEvidenceIds) evidenceIds.add(evidenceId);
          for (const evidenceId of binding.contradictsEvidenceIds) evidenceIds.add(evidenceId);
        }
        return {
          label: publicPlanGoalLabel(goal),
          status: goal.status,
          evidenceCount: [...evidenceIds].filter((evidenceId) => ledgerEvidenceIds.has(evidenceId)).length,
        };
      }),
      searchPlan: projectPublicSearchPlan(plan, ledgerEvidenceIds),
      ...(state.lastQueryTerms?.length ? { finalQueryTerms: state.lastQueryTerms } : {}),
      ...(phase === 'started' && state.plannerOutputJson ? { plannerOutputJson: state.plannerOutputJson } : {}),
    });
  }
  input.onPlanState?.(
    plan,
    ledger.toCitations(ledger.list().map((record) => record.evidenceId)),
    state.searchScope
      ? {
        searchScope: { ...state.searchScope, targetAspects: [...state.searchScope.targetAspects] },
        searchCoverage: state.coverageLedger.toPersistence(state.searchNextCursors),
      }
      : undefined,
  );
}

function publicPlanGoalLabel(goal: SearchPlan['goals'][number]): string {
  const raw = (goal.question.trim() || goal.requirements[0]?.label.trim() || '当前核实目标')
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '当前笔记')
    .replace(/\\\\[^\s]+/gu, '当前笔记')
    .replace(/\s+/gu, ' ')
    .trim();
  return raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
}

function recordVariantSignals(
  state: AgentState,
  plan: SearchPlan | undefined,
  goalId: string | undefined,
  observation: { emptySearch: boolean; evidenceAdded: boolean; variantTerms?: { source: 'note-map' | 'search-observation'; terms: string[] } },
  evidenceIdsBeforeTool: ReadonlySet<string>,
  ledger: CurrentNoteEvidenceLedger,
): void {
  if (!plan || !goalId) return;
  const goal = plan.goals.find((candidate) => candidate.goalId === goalId);
  if (!goal) return;
  const gate = getVariantGate(state, goalId);
  if (observation.emptySearch) gate.signals.add('empty-search');
  if (observation.evidenceAdded) gate.signals.add('coverage-insufficient');
  if (observation.variantTerms) {
    const currentTerms = new Set(goal.queryTerms.map((queryTerm) => normalizeVariantTerm(queryTerm.term)));
    const freshTerms = observation.variantTerms.terms
      .map(normalizeVariantTerm)
      .filter((term) => term.length >= 2 && !currentTerms.has(term));
    if (freshTerms.length > 0) {
      gate.signals.add('new-note-term');
      const destination = observation.variantTerms.source === 'note-map' ? gate.noteMapTerms : gate.searchObservationTerms;
      for (const term of freshTerms) destination.add(term);
    }
  }
  const newEvidenceIds = ledger.list()
    .map((record) => record.evidenceId)
    .filter((evidenceId) => !evidenceIdsBeforeTool.has(evidenceId));
  if (state.modelVariantSearchGoals.has(goalId)) {
    for (const evidenceId of newEvidenceIds) state.modelVariantEvidenceIds.add(evidenceId);
  }
}

function registerInvalidToolAction(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  tool: CurrentNoteToolName,
  error: unknown,
): void {
  const elapsedMs = 0;
  const errorMessage = error instanceof Error ? error.message : '工具动作无效。';
  state.lastActionFailureCode = /plan|patch|补丁|计划/u.test(errorMessage) ? 'invalid-plan-patch' : 'invalid-action-schema';
  state.lastActionFailureDetails = [errorMessage];
  state.decisionRepairCount += 1;
  state.noProgressCount += 1;
  state.invalidActionCount += 1;
  const summary = `工具 ${tool} 动作被拒绝；请根据参数约束重试。`;
  recordExecutionTrace(state, 'correction', state.searchPlan?.activeGoalId, tool, summary, []);
  emitTool(input, { tool, state: 'rejected', message: errorMessage, elapsedMs });
  if (state.invalidActionCount >= budget.maxInvalidActions) state.stopReason = 'invalid-action';
  else if (state.noProgressCount >= budget.maxNoProgressRounds) state.stopReason = 'no-progress';
}

interface ModelAnswerPlanFinalization {
  modelAuthoritative: true;
  planPatchProvided: boolean;
  planPatchApplied: boolean;
  planStatus: SearchPlan['status'];
  ignoredPlanPatchCode?: string;
}

/**
 * Mirrors an answer into the renderer-facing SearchPlan without making that
 * projection an answer gate. A malformed or incomplete planPatch is ignored;
 * the model's answer, completeness and stop decision stay untouched.
 */
function finalizePlanFromModelAnswer(
  state: AgentState,
  action: Extract<CurrentNoteAgentAction, { type: 'answer' }>,
  ledger: CurrentNoteEvidenceLedger,
  broadCoverage = false,
): ModelAnswerPlanFinalization {
  const originalPlan = state.searchPlan;
  if (!originalPlan) {
    return { modelAuthoritative: true, planPatchProvided: Boolean(action.planPatch), planPatchApplied: false, planStatus: 'partial' };
  }
  const evidenceIds = new Set(ledger.list().map((record) => record.evidenceId));
  let workingPlan = originalPlan;
  let planPatchApplied = false;
  let ignoredPlanPatchCode: string | undefined;
  if (action.planPatch) {
    const patched = applyModelSearchPlanPatch(workingPlan, action.planPatch, {
      evidenceIds,
      queryVariantScope: buildVariantScope(state),
      isAnswerFinalizing: true,
      ...(broadCoverage ? { relaxRequirementMinEvidence: true, allowConflictedComplete: true } : {}),
    });
    if (patched.ok) {
      workingPlan = patched.plan;
      planPatchApplied = true;
    } else {
      ignoredPlanPatchCode = patched.code;
    }
  }

  const hasCompletedGoals = workingPlan.goals.every((goal) => goal.status === 'covered'
    || (broadCoverage && goal.status === 'conflicted'));
  const requestedStatus = action.completeness === 'complete' && hasCompletedGoals
    ? 'completed'
    : action.completeness === 'not-found'
      ? 'not-found'
      : 'partial';
  const controllerOptions = broadCoverage
    ? { relaxRequirementMinEvidence: true, allowConflictedComplete: true }
    : {};
  try {
    state.searchPlan = setSearchPlanControllerStatus(workingPlan, requestedStatus, controllerOptions);
  } catch {
    const fallbackStatus = action.completeness === 'not-found' ? 'not-found' : 'partial';
    state.searchPlan = setSearchPlanControllerStatus(originalPlan, fallbackStatus, controllerOptions);
  }
  return {
    modelAuthoritative: true,
    planPatchProvided: Boolean(action.planPatch),
    planPatchApplied,
    planStatus: state.searchPlan.status,
    ...(ignoredPlanPatchCode ? { ignoredPlanPatchCode } : {}),
  };
}

function markPlanStale(plan: SearchPlan | undefined): SearchPlan | undefined {
  if (!plan || plan.status !== 'active') return plan;
  try {
    return markSearchPlanStale(plan);
  } catch {
    return plan;
  }
}

function prepareModelCall(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  callKind: PromptCallKind,
  prompt: string,
  retryOfTicketId?: string,
  evidencePromptManifest?: EvidencePromptManifest,
  promptProjection?: PromptProjection,
): { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined {
  const useEnvelopeBudget = promptProjection?.contextRuntimeMode === 'enforce'
    && promptProjection.serializedBudgetText !== undefined;
  if (input.modelCallCoordinator) {
    assertCurrentEvidencePromptManifest(input, callKind, evidencePromptManifest);
    const prepared = input.modelCallCoordinator.prepare({
      callKind,
      prompt,
      ...(useEnvelopeBudget ? {
        serializedBudgetText: promptProjection.serializedBudgetText,
        requestEnvelopeVersion: promptProjection.requestEnvelopeVersion,
      } : {}),
      ...(retryOfTicketId ? { retryOfTicketId } : {}),
      ...(evidencePromptManifest ? { evidencePromptManifest } : {}),
    });
    if (!prepared.ready) {
      state.stopReason = prepared.reason === 'timeout' ? 'timeout' : prepared.reason === 'model-budget' ? 'max-model-calls' : 'context-budget';
      return undefined;
    }
    state.modelCalls = input.modelCallCoordinator.gate.modelCalls;
    state.lastPromptPlan = prepared.call.plan;
    if (state.lastPromptStats) state.lastPromptStats = { ...state.lastPromptStats, predictedPromptTokens: prepared.call.plan.predictedPromptTokens, maxPromptTokens: prepared.call.plan.maxPromptTokens, maxOutputTokens: prepared.call.plan.maxOutputTokens, safetyReserveTokens: prepared.call.plan.safetyReserveTokens };
    return prepared.call;
  }
  const ticket = state.modelCallGate.reserve({ callKind, budgetKind: 'react-turn', ...(retryOfTicketId ? { retryOfTicketId } : {}) });
  if (!ticket) {
    state.stopReason = state.modelCallGate.isWithinDeadline() ? 'max-model-calls' : 'timeout';
    return undefined;
  }
  const plan = new PromptBudgetScheduler().plan({
    prompt,
    ...(useEnvelopeBudget ? {
      serializedBudgetText: promptProjection.serializedBudgetText,
      requestEnvelopeVersion: promptProjection.requestEnvelopeVersion,
    } : {}),
    contextWindowTokens: input.contextWindowTokens,
    callKind,
    calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({
      providerKind: input.providerKind,
      model: input.model,
      callKind,
      ...(useEnvelopeBudget && promptProjection.requestEnvelopeVersion
        ? { requestEnvelopeVersion: promptProjection.requestEnvelopeVersion }
        : {}),
    }),
  });
  if (!plan.fits) {
    state.modelCallGate.cancelUnsent(ticket);
    state.stopReason = 'context-budget';
    return undefined;
  }
  try {
    assertCurrentEvidencePromptManifest(input, callKind, evidencePromptManifest, plan);
  } catch (error) {
    state.modelCallGate.cancelUnsent(ticket);
    throw error;
  }
  // Provider requests consume the ticket even when the provider later returns
  // invalid JSON, a timeout, or AI_CONTEXT_OVERFLOW.
  state.modelCallGate.markSent(ticket);
  state.modelCalls = state.modelCallGate.modelCalls;
  state.lastPromptPlan = plan;
  if (state.lastPromptStats) {
    state.lastPromptStats = {
      ...state.lastPromptStats,
      predictedPromptTokens: plan.predictedPromptTokens,
      maxPromptTokens: plan.maxPromptTokens,
      maxOutputTokens: plan.maxOutputTokens,
      safetyReserveTokens: plan.safetyReserveTokens,
    };
  }
  return { ticket, plan };
}

function assertCurrentEvidencePromptManifest(
  input: CurrentNoteAgentInput,
  callKind: PromptCallKind,
  manifest?: EvidencePromptManifest,
  plan?: PromptBudgetPlan,
): void {
  if (callKind !== 'synthesize' || !manifest) return;
  if (manifest.snapshotId !== input.snapshot.snapshotId || manifest.contentHash !== input.snapshot.contentHash) {
    throw new Error('最终模型发送前的 EvidencePromptManifest 已脱离当前快照。');
  }
  const retrieved = new Set(manifest.turnRetrievedEvidenceIds);
  const represented = new Set(manifest.representedEvidenceIds);
  if (manifest.missingEvidenceIds.length !== 0
    || retrieved.size !== represented.size
    || [...retrieved].some((evidenceId) => !represented.has(evidenceId))
    || manifest.representationCoverage !== 1) {
    throw new Error('最终模型发送前的 EvidencePromptManifest 未达到 100% 表示覆盖。');
  }
  if (plan && plan.predictedPromptTokens > plan.maxPromptTokens) {
    throw new Error('最终模型发送前的完整 Prompt 超出 maxPromptTokens。');
  }
}

function createModelCallSignal(input: CurrentNoteAgentInput, ticket: ModelCallTicket): AbortSignal {
  if (ticket.deadlineAt === undefined) return input.signal;
  const remainingMs = Math.max(1, ticket.deadlineAt - Date.now());
  return AbortSignal.any([input.signal, AbortSignal.timeout(remainingMs)]);
}

function resolveModelCallAbortReason(
  input: CurrentNoteAgentInput,
  ticket: ModelCallTicket,
  callSignal: AbortSignal,
): Extract<CurrentNoteAgentStats['stopReason'], 'cancelled' | 'snapshot-stale' | 'timeout'> | undefined {
  if (!input.isSnapshotCurrent()) return 'snapshot-stale';
  if (input.signal.aborted) return 'cancelled';
  if (ticket.deadlineAt !== undefined && (Date.now() >= ticket.deadlineAt || (callSignal.aborted && callSignal.reason instanceof DOMException && callSignal.reason.name === 'TimeoutError'))) return 'timeout';
  return undefined;
}

function observeModelUsage(
  input: CurrentNoteAgentInput,
  state: AgentState,
  callKind: PromptCallKind,
  prompt: string,
): (usage: AssistantTokenUsage) => void {
  return (usage) => {
    const calibration = input.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    calibration.observeUsage({ providerKind: input.providerKind, model: input.model, callKind }, estimateTokenCount(prompt), usage);
    if (state.lastPromptStats && state.lastPromptStats.callKind === callKind && usage.inputTokens !== undefined) {
      state.lastPromptStats = { ...state.lastPromptStats, predictedPromptTokens: usage.inputTokens };
    }
  };
}

async function runCurrentNotePlan(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  projection: PromptProjection,
  plannerInput: Parameters<CurrentNotePlanDriver['plan']>[0],
): Promise<CurrentNotePlanResult | undefined> {
  const prompt = projection.prompt;
  const prepared = prepareModelCall(input, state, budget, 'plan', prompt, undefined, undefined, projection);
  if (!prepared || !input.planner) return undefined;
  const callSignal = createModelCallSignal(input, prepared.ticket);
  try {
    const result = await input.planner.plan({ ...plannerInput, prompt, signal: callSignal, maxOutputTokens: prepared.plan.maxOutputTokens, onUsage: observeModelUsage(input, state, 'plan', prompt) });
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      return undefined;
    }
    return result;
  } catch (error) {
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      return undefined;
    }
    if (isAiContextOverflow(error)) {
      state.stopReason = 'context-budget';
      return undefined;
    }
    if (!isCurrentNotePlanValidationError(error) || error.invalidFields.length === 0) throw error;
    const repairInput = {
      ...plannerInput,
      invalidOutput: error.plannerOutput,
      invalidFields: error.invalidFields,
      validationMessage: error.message,
    };
    const retryPrompt = createCurrentNotePlanRepairPrompt(repairInput);
    const retry = prepareModelCall(input, state, budget, 'plan', retryPrompt, prepared.ticket.ticketId);
    if (!retry) return undefined;
    const retrySignal = createModelCallSignal(input, retry.ticket);
    try {
      const result = await input.planner.repair({
        ...repairInput,
        prompt: retryPrompt,
        signal: retrySignal,
        maxOutputTokens: retry.plan.maxOutputTokens,
        onUsage: observeModelUsage(input, state, 'plan', retryPrompt),
      });
      const retryAbortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (retryAbortReason) {
        state.stopReason = retryAbortReason;
        return undefined;
      }
      return result;
    } catch (retryError) {
      const retryAbortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (retryAbortReason) {
        state.stopReason = retryAbortReason;
        return undefined;
      }
      if (isAiContextOverflow(retryError)) {
        state.stopReason = 'context-budget';
        return undefined;
      }
      throw retryError;
    }
  }
}

async function runCurrentNoteDecision(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  initialProjection: PromptProjection,
  stablePrefix: string,
  ledger: CurrentNoteEvidenceLedger,
): Promise<CurrentNoteAgentAction | undefined> {
  const projectionLevels = chooseProjectionLevels(input, 'decide', initialProjection);
  let prepared: { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined;
  let sentPrompt = initialProjection.prompt;
  let lastPrepareFailure: CurrentNoteAgentStats['stopReason'] | undefined;
  for (const level of projectionLevels) {
    const candidateProjection = level === 0
      ? initialProjection
      : composeDecisionPrompt(stablePrefix, input.question, input.conversation, ledger, state, level);
    const previousStopReason = state.stopReason;
    state.stopReason = undefined;
    prepared = prepareModelCall(input, state, budget, 'decide', candidateProjection.prompt, undefined, undefined, candidateProjection);
    if (prepared) {
      sentPrompt = candidateProjection.prompt;
      break;
    }
    lastPrepareFailure = state.stopReason;
    state.stopReason = previousStopReason;
  }
  if (!prepared) {
    state.stopReason = lastPrepareFailure === 'max-model-calls' || lastPrepareFailure === 'timeout' ? lastPrepareFailure : 'context-budget';
    return undefined;
  }
  const callSignal = createModelCallSignal(input, prepared.ticket);
  const validationStartedAt = Date.now();
  try {
    const action = await input.driver.decide({ prompt: sentPrompt, signal: callSignal, maxOutputTokens: prepared.plan.maxOutputTokens, onUsage: observeModelUsage(input, state, 'decide', sentPrompt) });
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      return undefined;
    }
    state.lastActionFailureCode = undefined;
    state.lastActionFailureDetails = undefined;
    input.onDetailedTrace?.({
      stage: 'model',
      action: 'react-decision-model-output',
      status: 'completed',
      input: { promptProjectionLevel: state.highestProjectionLevel },
      output: action,
      elapsedMs: Date.now() - validationStartedAt,
    });
    return action;
  } catch (error) {
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      return undefined;
    }
    if (input.signal.aborted) throw error;
    if (!isAiContextOverflow(error)) {
      const failureCode = classifyStructuredActionFailure(error);
      state.lastActionFailureCode = failureCode;
      state.lastActionFailureDetails = structuredActionFailureDetails(error);
      input.onDetailedTrace?.({
        stage: 'model',
        action: 'react-decision-model-output',
        status: 'rejected',
        errorCode: failureCode,
        error: toDetailedTraceError(error),
        ...(state.lastActionFailureDetails.length ? { metadata: { contractDetails: state.lastActionFailureDetails } } : {}),
        elapsedMs: Date.now() - validationStartedAt,
      });
      if (failureCode === 'provider-timeout') state.stopReason = 'timeout';
      else if (failureCode !== 'context-overflow') state.decisionRepairCount += 1;
      return undefined;
    }
    state.lastActionFailureCode = 'context-overflow';
    state.lastActionFailureDetails = undefined;
    input.onDetailedTrace?.({
      stage: 'model',
      action: 'react-decision-model-output',
      status: 'rejected',
      errorCode: 'context-overflow',
      error: toDetailedTraceError(error),
      elapsedMs: Date.now() - validationStartedAt,
    });
    const retryProjection = composeDecisionPrompt(stablePrefix, input.question, input.conversation, ledger, state, 4);
    const retryPrompt = retryProjection.prompt;
    const retry = prepareModelCall(input, state, budget, 'decide', retryPrompt, prepared.ticket.ticketId, undefined, retryProjection);
    if (!retry) {
      state.stopReason = 'context-budget';
      return undefined;
    }
    const retrySignal = createModelCallSignal(input, retry.ticket);
    try {
      const action = await input.driver.decide({ prompt: retryPrompt, signal: retrySignal, maxOutputTokens: retry.plan.maxOutputTokens, onUsage: observeModelUsage(input, state, 'decide', retryPrompt) });
      const abortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (abortReason) {
        state.stopReason = abortReason;
        return undefined;
      }
      state.lastActionFailureCode = undefined;
      state.lastActionFailureDetails = undefined;
      input.onDetailedTrace?.({
        stage: 'model',
        action: 'react-decision-model-output-retry',
        status: 'completed',
        output: action,
      });
      return action;
    } catch (retryError) {
      const abortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (abortReason) {
        state.stopReason = abortReason;
        return undefined;
      }
      if (input.signal.aborted) throw retryError;
      if (isAiContextOverflow(retryError)) state.stopReason = 'context-budget';
      else {
        const failureCode = classifyStructuredActionFailure(retryError);
        state.lastActionFailureCode = failureCode;
        state.lastActionFailureDetails = structuredActionFailureDetails(retryError);
        if (failureCode === 'provider-timeout') state.stopReason = 'timeout';
      }
      input.onDetailedTrace?.({
        stage: 'model',
        action: 'react-decision-model-output-retry',
        status: 'rejected',
        errorCode: classifyStructuredActionFailure(retryError),
        error: toDetailedTraceError(retryError),
        ...(state.lastActionFailureDetails?.length ? { metadata: { contractDetails: state.lastActionFailureDetails } } : {}),
      });
      return undefined;
    }
  }
}

function classifyStructuredActionFailure(error: unknown): StructuredActionErrorCode {
  if (error instanceof StructuredActionError) return error.code;
  if (isAiContextOverflow(error)) return 'context-overflow';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'provider-timeout';
  if (error instanceof Error && /timeout|timed out|超时/iu.test(error.message)) return 'provider-timeout';
  if (error instanceof Error && /json/iu.test(error.message)) return 'invalid-json';
  return 'invalid-action-schema';
}

function structuredActionFailureDetails(error: unknown): string[] {
  if (error instanceof StructuredActionError) return [...error.details].slice(0, 5);
  if (isStructuredOutputContractError(error)) return [...error.violations].slice(0, 5);
  // Unknown provider/driver errors may contain raw model output. Only the two
  // explicit safe error types above are allowed back into a repair prompt.
  return [];
}

function chooseProjectionLevels(
  input: CurrentNoteAgentInput,
  callKind: Extract<PromptCallKind, 'decide' | 'synthesize'>,
  projection: Pick<PromptProjection, 'prompt' | 'serializedBudgetText' | 'requestEnvelopeVersion' | 'contextRuntimeMode'>,
): PromptProjectionLevel[] {
  const useEnvelopeBudget = projection.contextRuntimeMode === 'enforce' && projection.serializedBudgetText !== undefined;
  const plan = new PromptBudgetScheduler().plan({
    prompt: projection.prompt,
    ...(useEnvelopeBudget ? {
      serializedBudgetText: projection.serializedBudgetText,
      requestEnvelopeVersion: projection.requestEnvelopeVersion,
    } : {}),
    contextWindowTokens: input.contextWindowTokens,
    callKind,
    calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({
      providerKind: input.providerKind,
      model: input.model,
      callKind,
    }),
  });
  const ratio = plan.maxPromptTokens > 0 ? plan.predictedPromptTokens / plan.maxPromptTokens : 1;
  if (input.adaptiveContextMode !== 'enforce') return [0];
  if (ratio >= 0.94) return [4];
  if (ratio >= 0.90) return [3, 4];
  return [0, 3, 4];
}

function getSynthesisMaxPromptTokens(input: CurrentNoteAgentInput): number {
  return new PromptBudgetScheduler().plan({
    prompt: '',
    contextWindowTokens: input.contextWindowTokens,
    callKind: 'synthesize',
    calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({
      providerKind: input.providerKind,
      model: input.model,
      callKind: 'synthesize',
    }),
  }).maxPromptTokens;
}

async function ensureEvidenceCompressionProjection(
  input: CurrentNoteAgentInput,
  stablePrefix: string,
  ledger: CurrentNoteEvidenceLedger,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  contextMode: 'react-search' | 'memory-reuse',
  options: { candidateEvidenceIds?: readonly string[]; repairMessage?: string },
  startedAt: number,
): Promise<boolean> {
  if (!isAllRetrievedCompressionEnforced(input)) return true;
  const maxRounds = budget.maxCompressionRounds ?? DEFAULT_ALL_RETRIEVED_TURN_BUDGET.maxCompressionRounds;
  const maxBatches = budget.maxCompressionBatches ?? DEFAULT_ALL_RETRIEVED_TURN_BUDGET.maxCompressionBatches;
  const finalReserveMs = budget.finalSynthesisReserveMs ?? DEFAULT_ALL_RETRIEVED_TURN_BUDGET.finalSynthesisReserveMs;
  const compressionDeadlineAt = budget.maxWallTimeMs === undefined
    ? undefined
    : startedAt + budget.maxWallTimeMs - finalReserveMs;
  const promptOptions = {
    ...options,
    answerDepth: input.answerDepth,
    assistantEvidenceProjectionMode: input.assistantEvidenceProjectionMode,
    evidenceCompressionMode: input.evidenceCompressionMode,
    maxPromptTokens: getSynthesisMaxPromptTokens(input),
    snapshotId: input.snapshot.snapshotId,
    contentHash: input.snapshot.contentHash,
    compressedArtifacts: state.evidenceCompressionArtifacts,
    compressionRounds: state.evidenceCompressionRounds,
  };

  for (let pass = 0; pass <= maxRounds; pass += 1) {
    if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    if (!input.isSnapshotCurrent()) {
      state.stopReason = 'snapshot-stale';
      return false;
    }
    const currentPrompt = composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, 0, {
      ...promptOptions,
      compressedArtifacts: state.evidenceCompressionArtifacts,
      compressionRounds: state.evidenceCompressionRounds,
    });
    const currentPlan = new PromptBudgetScheduler().plan({
      prompt: currentPrompt.prompt,
      contextWindowTokens: input.contextWindowTokens,
      callKind: 'synthesize',
      calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({ providerKind: input.providerKind, model: input.model, callKind: 'synthesize' }),
    });
    if (currentPlan.fits) return true;
    const manifest = currentPrompt.evidencePromptManifest;
    const manifestOverflowTokens = Math.max(0, (manifest?.finalEvidenceTokens ?? estimateTokenCount(currentPrompt.prompt)) - (manifest?.evidenceBudgetTokens ?? currentPlan.maxPromptTokens));
    // The manifest budget is expressed in the local estimator's raw tokens,
    // while the send gate may apply a provider calibration multiplier. Convert
    // that calibrated deficit back to raw-token savings before selecting the
    // next cold batch; otherwise a prompt can meet the manifest budget yet
    // still be rejected by the final model-call scheduler.
    const calibratedOverflowTokens = Math.ceil(
      Math.max(0, currentPlan.predictedPromptTokens - currentPlan.maxPromptTokens)
      / Math.max(1, currentPlan.calibrationMultiplier),
    );
    const overflowTokens = Math.max(manifestOverflowTokens, calibratedOverflowTokens);
    const compressionTimedOut = compressionDeadlineAt !== undefined && Date.now() >= compressionDeadlineAt;
    if (pass >= maxRounds || state.evidenceCompressionBatchCount >= maxBatches || compressionTimedOut) {
      state.stopReason = compressionTimedOut ? 'timeout' : 'context-budget';
      return false;
    }

    const allEvidence = ledger.list();
    const compressedIds = new Set(state.evidenceCompressionArtifacts.flatMap((artifact) => artifact.sourceEvidenceIds));
    const rawUnits = allEvidence.filter((record) => !compressedIds.has(record.evidenceId));
    const compressionUnits = rawUnits.some((record) => !record.protected)
      ? rawUnits.map((record) => toCompressionSourceEvidence(record))
      : state.evidenceCompressionArtifacts.map((artifact) => toCompressionArtifactUnit(artifact, allEvidence));
    if (!compressionUnits.length) {
      state.stopReason = 'context-budget';
      return false;
    }
    const protectedEvidenceIds = deriveEvidenceCompressionProtectionIds(state.searchPlan, allEvidence);
    const batches = planEvidenceCompressionBatches({
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      evidence: compressionUnits,
      overflowTokens,
      targetReductionRatio: 0.35,
      protectedEvidenceIds,
      maxSourceTokensPerBatch: Math.max(512, Math.floor(currentPlan.maxPromptTokens * 0.18)),
    }).filter((batch) => !state.failedCompressionBatchIds.has(batch.batchId));
    if (!batches.length) {
      state.stopReason = 'context-budget';
      return false;
    }
    state.evidenceCompressionRounds = Math.max(state.evidenceCompressionRounds, pass + 1);
    for (const batch of batches) {
      if (state.evidenceCompressionBatchCount >= maxBatches || (compressionDeadlineAt !== undefined && Date.now() >= compressionDeadlineAt)) break;
      if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
      if (!input.isSnapshotCurrent()) {
        state.stopReason = 'snapshot-stale';
        return false;
      }
      const sourceUnits = compressionUnits.filter((record) => (batch.sourceUnitIds ?? batch.sourceEvidenceIds).includes(record.evidenceId));
      const stateVector = createEvidenceCompressionStateVector(input, state, batch, sourceUnits);
      const cached = state.evidenceCompressionCache.get(stateVector);
      try {
        const artifact = cached ?? await getEvidenceCompressionDriver(input, state, budget, compressionDeadlineAt).compressBatch({
          batch,
          evidence: sourceUnits,
          conflictBindings: createEvidenceCompressionConflictBindings(state.searchPlan),
          signal: input.signal,
        });
        if (!cached) state.evidenceCompressionCache.set(stateVector, artifact);
        state.evidenceCompressionArtifacts = mergeCompressionArtifact(state.evidenceCompressionArtifacts, artifact);
        state.evidenceCompressionBatchCount += 1;
      } catch (error) {
        state.failedCompressionBatchIds.add(batch.batchId);
        if (input.signal.aborted) throw error;
      }
      state.modelCalls = state.modelCallGate.modelCalls;
      const refreshed = composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, 0, {
        ...promptOptions,
        compressedArtifacts: state.evidenceCompressionArtifacts,
        compressionRounds: state.evidenceCompressionRounds,
      });
      const refreshedPlan = new PromptBudgetScheduler().plan({
        prompt: refreshed.prompt,
        contextWindowTokens: input.contextWindowTokens,
        callKind: 'synthesize',
        calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({ providerKind: input.providerKind, model: input.model, callKind: 'synthesize' }),
      });
      if (refreshedPlan.fits) return true;
    }
  }
  state.stopReason = 'context-budget';
  return false;
}

function getEvidenceCompressionDriver(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  compressionDeadlineAt: number | undefined,
): EvidenceCompressionDriver {
  if (state.evidenceCompressionDriver) return state.evidenceCompressionDriver;
  const coordinator = input.modelCallCoordinator ?? new ModelCallCoordinator(state.modelCallGate, input.contextWindowTokens, 'react-turn', undefined, {
    providerKind: input.providerKind,
    model: input.model,
    tokenCalibrationStore: input.tokenCalibrationStore ?? sharedTokenCalibrationStore,
    maxEvidenceCompressionCalls: budget.maxEvidenceCompressionCalls ?? DEFAULT_ALL_RETRIEVED_TURN_BUDGET.maxEvidenceCompressionCalls,
    finalSynthesisReserveMs: budget.finalSynthesisReserveMs ?? DEFAULT_ALL_RETRIEVED_TURN_BUDGET.finalSynthesisReserveMs,
  });
  state.evidenceCompressionDriver = new EvidenceCompressionDriver({
    model: input.model,
    modelProfileId: `${input.providerKind}:${input.model}`,
    tokenizerFingerprint: 'estimator-v2',
    coordinator,
    ...(compressionDeadlineAt !== undefined ? { compressionDeadlineAt } : {}),
  });
  return state.evidenceCompressionDriver;
}

function toCompressionSourceEvidence(record: CurrentNoteEvidenceRecord): EvidenceCompressionSourceEvidence {
  return {
    evidenceId: record.evidenceId,
    snapshotId: record.snapshotId,
    contentHash: record.contentHash,
    textHash: record.textHash,
    text: record.text,
    headingPath: [...record.headingPath],
    lineFrom: record.lineFrom,
    lineTo: record.lineTo,
    goalIds: [...record.goalIds],
    firstSeenSeq: record.firstSeenSeq,
    ...(record.bestScore !== undefined ? { bestScore: record.bestScore } : {}),
  };
}

function toCompressionArtifactUnit(artifact: EvidenceCompressionArtifact, evidence: readonly CurrentNoteEvidenceRecord[]): EvidenceCompressionSourceEvidence {
  const sourceRecords = evidence.filter((record) => artifact.sourceEvidenceIds.includes(record.evidenceId));
  return {
    evidenceId: artifact.artifactId,
    snapshotId: artifact.snapshotId,
    contentHash: artifact.contentHash,
    textHash: sha256(artifact.compressedSegments.map((segment) => segment.text).join('\n')),
    text: artifact.compressedSegments.map((segment) => segment.text).join('\n'),
    headingPath: [...(sourceRecords[0]?.headingPath ?? [])],
    lineFrom: sourceRecords.length ? Math.min(...sourceRecords.map((record) => record.lineFrom)) : undefined,
    lineTo: sourceRecords.length ? Math.max(...sourceRecords.map((record) => record.lineTo)) : undefined,
    goalIds: [...new Set(sourceRecords.flatMap((record) => record.goalIds))],
    firstSeenSeq: sourceRecords.length ? Math.min(...sourceRecords.map((record) => record.firstSeenSeq)) : Number.MAX_SAFE_INTEGER,
    representedEvidenceIds: [...artifact.sourceEvidenceIds],
  };
}

function createEvidenceCompressionConflictBindings(plan: SearchPlan | undefined): EvidenceCompressionConflictBinding[] {
  return (plan?.goals ?? []).flatMap((goal) => goal.conflictBindings.map((binding) => ({
    topic: `${goal.goalId}/${binding.requirementId}`,
    supportsEvidenceIds: [...binding.supportsEvidenceIds],
    contradictsEvidenceIds: [...binding.contradictsEvidenceIds],
  })));
}

function createEvidenceCompressionStateVector(
  input: CurrentNoteAgentInput,
  state: AgentState,
  batch: EvidenceCompressionBatch,
  sourceUnits: readonly EvidenceCompressionSourceEvidence[],
): EvidenceCompressionCacheStateVector {
  return {
    libraryId: input.snapshot.libraryId,
    noteId: input.snapshot.relativePath,
    sessionId: input.memoryScopeKey,
    turnId: sha256(`${input.memoryScopeKey}\u0000${input.question}\u0000${input.snapshot.snapshotId}`),
    planId: state.searchPlan?.planId ?? 'no-plan',
    planVersion: state.searchPlan?.version ?? 0,
    questionHash: sha256(input.question),
    snapshotId: batch.snapshotId,
    contentHash: batch.contentHash,
    sourceEvidenceIds: [...batch.sourceEvidenceIds],
    sourceTextHashes: Object.fromEntries(sourceUnits.map((record) => [record.evidenceId, record.textHash])),
    compressionPolicyVersion: 'stage4-v1',
    targetReductionRatio: batch.targetReductionRatio,
    modelProfileId: `${input.providerKind}:${input.model}`,
    tokenizerFingerprint: 'estimator-v2',
  };
}

function mergeCompressionArtifact(existing: readonly EvidenceCompressionArtifact[], artifact: EvidenceCompressionArtifact): EvidenceCompressionArtifact[] {
  const replacedIds = new Set(artifact.sourceEvidenceIds);
  return [...existing.filter((current) => !current.sourceEvidenceIds.some((evidenceId) => replacedIds.has(evidenceId))), artifact];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function synthesizeAnswer(
  input: CurrentNoteAgentInput,
  stablePrefix: string,
  ledger: CurrentNoteEvidenceLedger,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  contextMode: 'react-search' | 'memory-reuse',
  options: { candidateEvidenceIds?: readonly string[]; repairMessage?: string } = {},
): Promise<Extract<CurrentNoteAgentAction, { type: 'answer' }>> {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) throw new Error('当前笔记快照已失效。');
  const compressionReady = await ensureEvidenceCompressionProjection(input, stablePrefix, ledger, state, budget, contextMode, options, state.startedAt);
  if (!compressionReady) throw new Error('当前证据在压缩和最终合成预算内无法完整表示。');
  const promptOptions = {
    ...options,
    answerDepth: input.answerDepth,
    assistantEvidenceProjectionMode: input.assistantEvidenceProjectionMode,
    evidenceCompressionMode: input.evidenceCompressionMode,
    maxPromptTokens: getSynthesisMaxPromptTokens(input),
    snapshotId: input.snapshot.snapshotId,
    contentHash: input.snapshot.contentHash,
    compressedArtifacts: state.evidenceCompressionArtifacts,
    compressionRounds: state.evidenceCompressionRounds,
  };
  const basePrompt = composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, 0, promptOptions);
  const projectionLevels = chooseProjectionLevels(input, 'synthesize', basePrompt.projection);
  const prompts = projectionLevels.map((projectionLevel) => ({
    projectionLevel: projectionLevel as PromptProjectionLevel,
    ...composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, projectionLevel as PromptProjectionLevel, promptOptions),
  }));
  let prepared: { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined;
  let prompt = prompts[0].prompt;
  const terminalStopReason = state.stopReason;
  let lastPrepareFailure: CurrentNoteAgentStats['stopReason'] | undefined;
  for (const candidate of prompts) {
    const previousStopReason = state.stopReason;
    state.stopReason = undefined;
    const candidatePrepared = prepareModelCall(input, state, budget, 'synthesize', candidate.prompt, undefined, candidate.evidencePromptManifest, candidate.projection);
    if (candidatePrepared) {
      prepared = candidatePrepared;
      prompt = candidate.prompt;
      break;
    }
    lastPrepareFailure = state.stopReason;
    state.stopReason = previousStopReason;
  }
  if (terminalStopReason) state.stopReason = terminalStopReason;
  else if (!prepared) state.stopReason = lastPrepareFailure === 'max-model-calls' || lastPrepareFailure === 'timeout' ? lastPrepareFailure : 'context-budget';
  if (!prepared) throw new Error('当前模型调用无法在预算内发送。');
  const callSignal = createModelCallSignal(input, prepared.ticket);
  const synthesisValidationStartedAt = Date.now();
  try {
    const action = await input.driver.synthesize({ prompt, signal: callSignal, maxOutputTokens: prepared.plan.maxOutputTokens, onUsage: observeModelUsage(input, state, 'synthesize', prompt) });
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      throw new Error('模型调用已达到本轮截止时间。');
    }
    state.lastActionFailureCode = undefined;
    input.onDetailedTrace?.({
      stage: 'model',
      action: 'synthesize-model-output',
      status: 'completed',
      output: action,
      elapsedMs: Date.now() - synthesisValidationStartedAt,
    });
    return action;
  } catch (error) {
    const abortReason = resolveModelCallAbortReason(input, prepared.ticket, callSignal);
    if (abortReason) {
      state.stopReason = abortReason;
      throw error;
    }
    if (input.signal.aborted) throw error;
    if (!isAiContextOverflow(error)) {
      const failureCode = classifyStructuredActionFailure(error);
      state.lastActionFailureCode = failureCode;
      input.onDetailedTrace?.({
        stage: 'model',
        action: 'synthesize-model-output',
        status: 'rejected',
        errorCode: failureCode,
        error: toDetailedTraceError(error),
        elapsedMs: Date.now() - synthesisValidationStartedAt,
      });
      if (failureCode === 'provider-timeout') state.stopReason = 'timeout';
      throw error;
    }
    observeSynthesisContextOverflow(input, prompt, error);
    input.onDetailedTrace?.({
      stage: 'model',
      action: 'synthesize-model-output',
      status: 'rejected',
      errorCode: 'context-overflow',
      error: toDetailedTraceError(error),
      elapsedMs: Date.now() - synthesisValidationStartedAt,
    });
    const recompressed = await ensureEvidenceCompressionProjection(input, stablePrefix, ledger, state, budget, contextMode, options, state.startedAt);
    if (!recompressed) throw error;
    const retryPromptOptions = {
      ...promptOptions,
      compressedArtifacts: state.evidenceCompressionArtifacts,
      compressionRounds: state.evidenceCompressionRounds,
    };
    const retryBasePrompt = composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, 0, retryPromptOptions);
    const retryLevels = chooseProjectionLevels(input, 'synthesize', retryBasePrompt.projection);
    let retry: { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined;
    let retryPrompt = retryBasePrompt.prompt;
    for (const level of retryLevels) {
      const candidate = composeAnswerPrompt(stablePrefix, input.question, ledger, contextMode, state.searchPlan, state, level, retryPromptOptions);
      const preparedRetry = prepareModelCall(input, state, budget, 'synthesize', candidate.prompt, prepared.ticket.ticketId, candidate.evidencePromptManifest, candidate.projection);
      if (!preparedRetry) continue;
      retry = preparedRetry;
      retryPrompt = candidate.prompt;
      break;
    }
    if (!retry) throw error;
    const retrySignal = createModelCallSignal(input, retry.ticket);
    try {
      const action = await input.driver.synthesize({ prompt: retryPrompt, signal: retrySignal, maxOutputTokens: retry.plan.maxOutputTokens, onUsage: observeModelUsage(input, state, 'synthesize', retryPrompt) });
      const abortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (abortReason) {
        state.stopReason = abortReason;
        throw new Error('模型调用已达到本轮截止时间。');
      }
      state.lastActionFailureCode = undefined;
      input.onDetailedTrace?.({ stage: 'model', action: 'synthesize-model-output-retry', status: 'completed', output: action });
      return action;
    } catch (retryError) {
      const abortReason = resolveModelCallAbortReason(input, retry.ticket, retrySignal);
      if (abortReason) {
        state.stopReason = abortReason;
        throw retryError;
      }
      if (isAiContextOverflow(retryError)) state.stopReason = 'context-budget';
      else if (classifyStructuredActionFailure(retryError) === 'provider-timeout') state.stopReason = 'timeout';
      input.onDetailedTrace?.({
        stage: 'model',
        action: 'synthesize-model-output-retry',
        status: 'rejected',
        errorCode: classifyStructuredActionFailure(retryError),
        error: toDetailedTraceError(retryError),
      });
      throw retryError;
    }
  }
}

function observeSynthesisContextOverflow(input: CurrentNoteAgentInput, prompt: string, error: { providerLimitTokens?: number }): void {
  const calibration = input.tokenCalibrationStore ?? sharedTokenCalibrationStore;
  const key = { providerKind: input.providerKind, model: input.model, callKind: 'synthesize' };
  const localTokens = Math.max(1, estimateTokenCount(prompt));
  const currentMultiplier = calibration.getMultiplier(key);
  const nextMultiplier = Math.min(1.50, Math.max(currentMultiplier * 1.10, currentMultiplier + 0.05));
  calibration.observe({
    key,
    locallyEstimatedTokens: localTokens,
    providerInputTokens: Math.max(Math.ceil(localTokens * nextMultiplier), error.providerLimitTokens ?? 0, localTokens + 1),
  });
}

function finalize(
  input: CurrentNoteAgentInput,
  prefixFingerprint: string,
  ledger: CurrentNoteEvidenceLedger,
  state: AgentState,
  action: Extract<CurrentNoteAgentAction, { type: 'answer' }>,
  contextMode: Extract<CurrentNoteContextMode, 'react-search' | 'memory-reuse'>,
  route: 'react-search' | 'clarify' = 'react-search',
  searchPlan?: SearchPlan,
): CurrentNoteAgentResult {
  const answer = action.answer;
  const completeness = action.completeness;
  const sourceRecords = ledger.list();
  const sourceLinks = ledger.toCitations(action.citations);
  if (contextMode === 'react-search' && completeness === 'complete' && sourceRecords.length > 0 && input.isSnapshotCurrent()) {
    input.memory.remember(input.memoryScopeKey, createMemoryEntry({ snapshot: input.snapshot, question: input.question, evidence: sourceRecords, answer, completeness }));
  }
  const finalPromptAssembly = composeAnswerPrompt(createCurrentNotePrompt({
    snapshot: input.snapshot,
    question: input.question,
    conversation: input.conversation,
    providerKind: input.providerKind,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    skillInstructions: input.skillInstructions,
    answerDepth: input.answerDepth,
  }).stablePrefix, input.question, ledger, contextMode, searchPlan, state, state.highestProjectionLevel, {
    answerDepth: input.answerDepth,
    assistantEvidenceProjectionMode: input.assistantEvidenceProjectionMode,
    evidenceCompressionMode: input.evidenceCompressionMode,
    maxPromptTokens: getSynthesisMaxPromptTokens(input),
    snapshotId: input.snapshot.snapshotId,
    contentHash: input.snapshot.contentHash,
    compressedArtifacts: state.evidenceCompressionArtifacts,
    compressionRounds: state.evidenceCompressionRounds,
  });
  const finalPrompt = finalPromptAssembly.prompt;
  const contextDiagnostics = finalPromptAssembly.projection.contextEnvelope
    ? createContextProjectionDiagnostics({
      envelope: finalPromptAssembly.projection.contextEnvelope,
      ...(finalPromptAssembly.projection.contextProjection ? { projection: finalPromptAssembly.projection.contextProjection } : {}),
      mode: state.contextRuntime.mode === 'off' ? 'observe' : state.contextRuntime.mode,
      sendPath: state.contextRuntime.mode === 'enforce' ? 'projection-enforce' : 'legacy-observe',
    })
    : undefined;
  if (state.lastPromptStats && state.lastPromptPlan?.callKind === 'synthesize') {
    state.lastPromptStats = {
      ...state.lastPromptStats,
      predictedPromptTokens: state.lastPromptPlan.predictedPromptTokens,
      maxPromptTokens: state.lastPromptPlan.maxPromptTokens,
      maxOutputTokens: state.lastPromptPlan.maxOutputTokens,
      safetyReserveTokens: state.lastPromptPlan.safetyReserveTokens,
    };
  }
  return {
    answer,
    contextMode,
    route,
    // Citation ids are projected only for UI navigation. Missing or unknown ids
    // never change the model's answer, completeness or stop reason.
    evidence: sourceLinks,
    completeness,
    toolStats: { calls: state.toolCalls, searchedBlocks: state.searchedBlocks, readCharacters: state.readCharacters, elapsedMs: state.elapsedMs },
    agentStats: { decisionRounds: state.decisionRounds, modelCalls: state.modelCalls, stopReason: state.stopReason ?? 'answered' },
    prefixFingerprint,
    contextUsage: {
      ...estimateAssistantContextUsage(finalPrompt, input.contextWindowTokens, undefined, input.contextWindow),
      ...(state.lastPromptStats ? { promptStats: state.lastPromptStats } : {}),
    },
    ...(state.lastPromptStats ? { promptStats: state.lastPromptStats } : {}),
    ...(contextDiagnostics ? { contextDiagnostics } : {}),
    ...(searchPlan ? { searchPlan } : {}),
    ...(state.searchScope ? { searchScope: state.searchScope } : {}),
    coverage: state.coverageLedger.toSummary(state.searchPlan ? Math.max(1, ...state.searchPlan.goals.flatMap((goal) => goal.requirements.map((requirement) => requirement.minEvidence))) : 1),
    agentMessages: state.agentMessages,
  };
}

function toQaAgentToolArguments(action: ValidatedToolAction): Record<string, unknown> {
  const { tool: _tool, ...argumentsValue } = action;
  return argumentsValue;
}

function beforeDecision(input: CurrentNoteAgentInput, state: AgentState, budget: CurrentNoteAgentBudget, startedAt: number): CurrentNoteAgentStats['stopReason'] | undefined {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) return 'snapshot-stale';
  if (hasWallTimeExpired(budget, startedAt)) return 'timeout';
  if (state.searchPlan?.status === 'active' && state.searchPlan.activeGoalId === null) return 'no-progress';
  if (state.decisionRounds >= budget.maxDecisionRounds) return 'max-decision-rounds';
  if (state.modelCalls >= budget.maxModelCalls - 1) return 'max-model-calls';
  return undefined;
}

function beforeTool(
  input: CurrentNoteAgentInput,
  state: AgentState,
  budget: CurrentNoteAgentBudget,
  startedAt: number,
): CurrentNoteAgentStats['stopReason'] | undefined {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) return 'snapshot-stale';
  if (hasWallTimeExpired(budget, startedAt)) return 'timeout';
  if (state.toolCalls >= budget.maxToolCalls) return 'max-tool-calls';
  return undefined;
}

function hasWallTimeExpired(budget: CurrentNoteAgentBudget, startedAt: number): boolean {
  return budget.maxWallTimeMs !== undefined && Date.now() - startedAt >= budget.maxWallTimeMs;
}

function isPlanSearchPaginationEnabled(planMode: AssistantPlanMode | undefined): boolean {
  return planMode !== undefined && planMode !== 'off' && planMode !== 'shadow-plan';
}

/**
 * A single active goal is controller-authoritative, so a missing goalId can
 * be repaired without allowing the model to choose a different goal. A wrong
 * supplied ID remains a rejected action in preparePlanForTool.
 */
function bindMissingPlanGoalId(
  action: CurrentNoteAgentAction | undefined,
  plan: SearchPlan | undefined,
  planMode: AssistantPlanMode | undefined,
): CurrentNoteAgentAction | undefined {
  if (!action || !isPlanSearchPaginationEnabled(planMode) || action.type !== 'tool' || action.goalId) return action;
  const activeGoalId = plan?.activeGoalId;
  return activeGoalId ? { ...action, goalId: activeGoalId } : action;
}

/** Plan mode executes the accepted plan vocabulary, not transient Decide arguments. */
function bindPlanSearchQueryTerms(
  action: Extract<CurrentNoteAgentAction, { type: 'tool' }>,
  plan: SearchPlan | undefined,
  planMode: AssistantPlanMode | undefined,
  batchOffsets: ReadonlyMap<string, number>,
): Extract<CurrentNoteAgentAction, { type: 'tool' }> {
  if (action.tool !== 'search_note' || !isPlanSearchPaginationEnabled(planMode) || !plan) return action;
  const goalId = action.goalId ?? plan.activeGoalId;
  if (!goalId) throw new Error('当前计划没有可执行的 activeGoalId。');
  const pendingPlanVariants = action.planPatch?.goalUpdates
    .filter((update) => update.goalId === goalId)
    .flatMap((update) => update.queryVariants ?? [])
    .map((variant) => normalizeTechnicalTerm(variant.term).replace(/\s+/gu, ' '))
    .filter(Boolean) ?? [];
  const offset = batchOffsets.get(normalizeSearchCursorKey(goalId)) ?? 0;
  const batch = createStableSearchGoalTermBatch(plan, goalId, offset, pendingPlanVariants);
  if (batch.length === 0) {
    throw new Error('当前目标的 QueryTerm 批次已全部执行；请读取已有命中、追加新的 queryVariant 或结束目标。');
  }
  return { ...action, arguments: { ...action.arguments, terms: batch } };
}

function normalizeSearchCursorKey(goalId: string | undefined): string {
  return goalId?.trim() || '__turn__';
}

function createCoverageQueryFingerprint(terms: readonly string[], scope?: CurrentNoteSearchScope): string {
  const normalizedTerms = [...new Set(terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))].sort();
  return createHash('sha256').update(JSON.stringify({
    terms: normalizedTerms,
    scope: scope
      ? { mode: scope.mode, targetTopic: scope.targetTopic ?? '', targetAspects: [...scope.targetAspects].sort() }
      : { mode: 'focused', targetTopic: '', targetAspects: [] },
  }), 'utf8').digest('hex');
}

function stableOrderedTerms(terms: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

function emitTool(input: CurrentNoteAgentInput, event: CurrentNotePublicToolEvent): void {
  input.onToolEvent?.(event);
}

/** Produces renderer-safe parameters without serializing raw evidence or local paths. */
function summarizeCurrentNoteToolInput(action: ValidatedToolAction): string {
  switch (action.tool) {
    case 'get_note_map':
      return `查看：${action.detail === 'outline' ? '目录结构' : action.detail === 'stats' ? '统计信息' : '关键词'}`;
    case 'search_note': {
      const terms = action.terms
        .map((term) => term.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, 48))
        .filter(Boolean)
        .slice(0, CURRENT_NOTE_SEARCH_TERM_LIMIT);
      return `关键词：${terms.join('、') || '无'}；最多 ${action.limit} 个片段${action.cursor ? '；使用主进程分页 cursor' : ''}`;
    }
    case 'read_note_range':
      return `行范围：L${action.lineFrom}–L${action.lineTo}`;
    case 'read_note_section':
      return action.cursor === undefined ? '章节：从章节起始处读取' : `章节：从续读位置 ${action.cursor} 读取`;
    case 'expand_evidence':
      return `现有证据：向前 ${action.beforeLines} 行、向后 ${action.afterLines} 行`;
    case 'search_conversations':
      return `历史对话：${action.query.slice(0, 80)}；最多 ${action.limit} 条`;
  }
}

function validateToolAction(
  action: Extract<CurrentNoteAgentAction, { type: 'tool' }>,
  snapshot: CurrentNoteSnapshot,
  sectionNextCursors: ReadonlyMap<string, number>,
  searchNextCursors: ReadonlyMap<string, string>,
  allowSearchPagination: boolean,
  conversationSearchAvailable: boolean,
): ValidatedToolAction {
  const args = action.arguments;
  switch (action.tool) {
    case 'get_note_map':
      assertKeys(args, ['detail']);
      if (args.detail !== undefined && args.detail !== 'outline' && args.detail !== 'stats' && args.detail !== 'terms') throw new Error('笔记地图 detail 无效。');
      return { tool: action.tool, detail: (args.detail ?? 'outline') as CurrentNoteMapDetail };
    case 'search_note':
      assertKeys(args, allowSearchPagination ? ['terms', 'limit', 'cursor'] : ['terms', 'limit']);
      if (!Array.isArray(args.terms) || !args.terms.every((term) => typeof term === 'string')) throw new Error('搜索词格式无效。');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) throw new Error('搜索命中数无效。');
      if (args.cursor !== undefined) {
        if (!allowSearchPagination) throw new Error('只有 Plan 路径允许使用 search_note cursor。');
        if (typeof args.cursor !== 'string' || !args.cursor.trim() || args.cursor.length > 160) throw new Error('search_note cursor 无效。');
        const expectedCursor = searchNextCursors.get(normalizeSearchCursorKey(action.goalId));
        if (!expectedCursor || args.cursor !== expectedCursor) throw new Error('search_note cursor 必须来自主进程上一次返回的 nextCursor。');
      }
      return { tool: action.tool, terms: args.terms, limit: (args.limit ?? 8) as number, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) };
    case 'read_note_range':
      assertKeys(args, ['lineFrom', 'lineTo']);
      return { tool: action.tool, lineFrom: readInteger(args.lineFrom, '起始行'), lineTo: readInteger(args.lineTo, '结束行') };
    case 'read_note_section':
      assertKeys(args, ['headingId', 'cursor']);
      if (typeof args.headingId !== 'string' || !args.headingId.trim() || args.headingId.length > 160) throw new Error('章节标识无效。');
      {
        const headingId = args.headingId.trim();
        if (!snapshot.headings.some((heading) => heading.headingId === headingId)) throw new Error('章节标识无效。');
        if (args.cursor === undefined) return { tool: action.tool, headingId };
        const expectedCursor = sectionNextCursors.get(headingId);
        if (!Number.isInteger(args.cursor) || args.cursor !== expectedCursor) {
          return { tool: action.tool, headingId, cursorWasReset: true };
        }
        return { tool: action.tool, headingId, cursor: args.cursor as number };
      }
    case 'expand_evidence':
      assertKeys(args, ['evidenceId', 'beforeLines', 'afterLines']);
      if (typeof args.evidenceId !== 'string' || !/^evidence-[a-f0-9]{24}$/u.test(args.evidenceId)) throw new Error('证据标识无效。');
      return {
        tool: action.tool,
        evidenceId: args.evidenceId,
        beforeLines: args.beforeLines === undefined ? 20 : readBoundedInteger(args.beforeLines, '前置扩展行数', 0, 40),
        afterLines: args.afterLines === undefined ? 20 : readBoundedInteger(args.afterLines, '后置扩展行数', 0, 40),
      };
    case 'search_conversations':
      if (!conversationSearchAvailable) throw new Error('历史对话档案当前不可用。');
      assertKeys(args, ['query', 'limit']);
      if (typeof args.query !== 'string' || !args.query.trim() || Array.from(args.query.trim()).length > 500) {
        throw new Error('历史对话 query 必须是 1 到 500 个字符。');
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8)) {
        throw new Error('历史对话命中数必须是 1 到 8 的整数。');
      }
      return { tool: action.tool, query: args.query.trim(), limit: (args.limit ?? 5) as number };
  }
}

/** Computes a controller-only read quota from the last complete decision plan. */
function computeInternalReadLimits(input: CurrentNoteAgentInput, state: AgentState, budget: CurrentNoteAgentBudget): CurrentNoteReadLimits {
  const maxPromptTokens = state.lastPromptPlan?.maxPromptTokens ?? Math.max(1_024, Math.floor((input.contextWindowTokens ?? ASSISTANT_CONTEXT_BUDGET_TOKENS) * 0.4));
  const currentProjectedTokens = state.lastPromptPlan?.predictedPromptTokens ?? 0;
  const reservedForNextDecision = Math.max(512, Math.floor(maxPromptTokens * 0.12));
  const reservedForSynthesis = Math.max(512, Math.floor(maxPromptTokens * 0.12));
  const remainingDynamicTokens = Math.max(128, maxPromptTokens - currentProjectedTokens - reservedForNextDecision - reservedForSynthesis);
  const readCeilingTokens = (input.contextWindowTokens ?? ASSISTANT_CONTEXT_BUDGET_TOKENS) >= 65_536 ? 3_072 : 2_048;
  const maxTokens = Math.min(readCeilingTokens, remainingDynamicTokens);
  return {
    maxTokens,
    maxChars: Math.min(budget.maxSingleObservationChars, Math.max(512, maxTokens * 4)),
    maxLines: Math.min(300, Math.max(8, Math.floor(maxTokens / 4))),
  };
}

async function executeConversationSearchTool(
  action: Extract<ValidatedToolAction, { tool: 'search_conversations' }>,
  runtime: SearchConversationsToolRuntime | undefined,
): Promise<ToolObservation> {
  if (!runtime) throw new Error('历史对话档案当前不可用。');
  const result = await runtime.search(action.query, action.limit);
  if (!result.availability.enabled) throw new Error(`历史对话档案当前不可用：${result.availability.reason ?? 'unknown'}。`);
  const summary = result.matches.length ? result.observation : '<past_conversations>\n</past_conversations>';
  return {
    summary,
    publicMessage: result.matches.length
      ? `在其他会话中找到 ${result.matches.length} 条历史原话${result.vectorUsed ? '（关键词与向量融合）' : '（关键词匹配）'}。`
      : '其他会话中未找到匹配原话。',
    detailedOutput: {
      matchCount: result.matches.length,
      vectorUsed: result.vectorUsed,
      matches: result.matches,
    },
    evidenceAdded: false,
    searchedBlocks: 0,
    readCharacters: Array.from(summary).length,
    emptySearch: result.matches.length === 0,
  };
}

function executeTool(
  action: Exclude<ValidatedToolAction, { tool: 'search_conversations' }>,
  tools: ReturnType<typeof createCurrentNoteTools>,
  snapshot: CurrentNoteSnapshot,
  ledger: CurrentNoteEvidenceLedger,
  toolCallId: string,
  question: string,
  budget: CurrentNoteAgentBudget,
  readLimits: CurrentNoteReadLimits,
  searchScope: CurrentNoteSearchScope | undefined,
  coverageLedger: CurrentNoteSearchCoverageLedger,
  goalId: string | undefined,
  useSearchPagination: boolean,
  autoMaterializeSearchHits: boolean,
  plannedQueryTerms?: readonly string[],
): ToolObservation {
    switch (action.tool) {
    case 'get_note_map': {
      const map = tools.getNoteMap(action.detail);
      const mapTerms = action.detail === 'terms'
        ? map.topTerms ?? []
        : action.detail === 'outline'
          ? map.headings.flatMap((heading) => [heading.text, ...heading.path])
          : [];
      return { summary: `地图：${map.headings.slice(0, 24).map((heading) => `${heading.headingId}@${heading.lineFrom}-${heading.lineTo}`).join('；')}`, publicMessage: '已读取笔记结构。', detailedOutput: map, evidenceAdded: false, searchedBlocks: 0, readCharacters: 0, emptySearch: false, ...(mapTerms.length ? { variantTerms: { source: 'note-map', terms: [...collectScopeTerms(mapTerms)] } } : {}) };
    }
    case 'search_note': {
      const page = useSearchPagination
        ? tools.searchNotePage(action.terms, action.limit, action.cursor, searchScope)
        : undefined;
      const hits = page?.hits ?? tools.searchNote(action.terms, action.limit, searchScope);
      const executedQueryTerms = stableOrderedTerms(action.terms);
      let materializedRecords: CurrentNoteEvidenceRecord[] = [];
      let addedRecords: CurrentNoteEvidenceRecord[] = [];
      if (autoMaterializeSearchHits) {
        const originals = materializeCurrentNoteSearchHits(snapshot, hits);
        const admitted = ledger.addBatch(hits.map((hit, index) => ({
          blockIds: [originals[index].blockId],
          headingPath: originals[index].headingPath,
          lineFrom: originals[index].lineFrom,
          lineTo: originals[index].lineTo,
          text: originals[index].text,
          matchedTerms: [...hit.matchedTerms],
          supports: [question],
          sourceToolCallId: toolCallId,
          admission: 'search-hit' as const,
          ...(goalId ? { goalId } : {}),
          searchHitId: hit.hitId,
          bestScore: hit.score,
        })));
        materializedRecords = admitted.records;
        addedRecords = admitted.addedRecords;
      }
      coverageLedger.recordSearch(
        goalId,
        hits,
        action.limit,
        page
          ? {
            candidateExhausted: page.candidateExhausted,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            queryFingerprint: createCoverageQueryFingerprint(action.terms, searchScope),
            ...(plannedQueryTerms ? { plannedQueryTerms, executedQueryTerms } : {}),
            ...(autoMaterializeSearchHits ? { materialized: materializedRecords.map(toCoverageReadInput) } : {}),
          }
          : autoMaterializeSearchHits
            ? {
              candidateExhausted: true,
              plannedQueryTerms,
              executedQueryTerms,
              materialized: materializedRecords.map(toCoverageReadInput),
            }
            : undefined,
      );
      const searchSet = hits.map((hit) => hit.blockId).sort().join(',');
      const observationTerms = hits.flatMap((hit) => {
        const hasNonFuzzyMatch = hit.matchTrace.some((trace) => trace.matchType !== 'fuzzy');
        return hasNonFuzzyMatch
          ? [...hit.matchedTerms, ...hit.matchTrace.filter((trace) => trace.matchType !== 'fuzzy').map((trace) => trace.matchedTerm), ...hit.headingPath]
          : [];
      });
      return {
        summary: hits.length ? `搜索命中：${hits.map((hit) => `${hit.blockId}@${hit.lineFrom}-${hit.lineTo}`).join('；')}` : '搜索未命中。',
        publicMessage: hits.length ? `已定位到 ${hits.length} 个候选片段。` : '未找到匹配片段。',
        detailedOutput: {
          snapshotId: snapshot.snapshotId,
          terms: action.terms,
          limit: action.limit,
          hits,
          ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
          ...(page ? { candidateExhausted: page.candidateExhausted } : {}),
          ...(materializedRecords.length ? { materializedRecords } : {}),
        },
        ...(hits.length && !autoMaterializeSearchHits ? { contentPreviews: createSearchContentPreviews(hits) } : {}),
        evidenceAdded: addedRecords.length > 0,
        searchedBlocks: hits.length,
        readCharacters: addedRecords.reduce((total, record) => total + record.text.length, 0),
        emptySearch: hits.length === 0,
        searchSet,
        ...(page?.nextCursor ? { searchNextCursor: page.nextCursor } : {}),
        ...(page ? { candidateExhausted: page.candidateExhausted } : {}),
        ...(observationTerms.length ? { variantTerms: { source: 'search-observation', terms: [...collectScopeTerms(observationTerms)] } } : {}),
      };
    }
    case 'read_note_range': {
      const range = tools.readNoteRange({ lineFrom: action.lineFrom, lineTo: action.lineTo }, readLimits);
      return evidenceObservation({ snapshot, ledger, coverageLedger, goalId, toolCallId, question, budget, blockIds: range.blockIds, headingPath: range.headingPath, lineFrom: range.lineFrom, lineTo: range.lineTo, text: range.text, label: '行范围', nextCursor: range.nextCursor });
    }
    case 'read_note_section': {
      const section = tools.readNoteSection({ headingId: action.headingId, ...(action.cursor !== undefined ? { cursor: action.cursor } : {}) }, readLimits);
      const observation = evidenceObservation({ snapshot, ledger, coverageLedger, goalId, toolCallId, question, budget, blockIds: section.blockIds, headingPath: section.headingPath, lineFrom: section.lineFrom, lineTo: section.lineTo, text: section.text, label: '章节', headingId: section.headingId, nextCursor: section.nextCursor });
      return {
        ...observation,
        sectionHeadingId: section.headingId,
        ...(action.cursorWasReset ? {
          summary: `模型提供的 cursor 不是本章节上一次返回的 nextCursor，已从章节起始行读取。${observation.summary}`,
          publicMessage: `章节游标已安全重置。${observation.publicMessage}`,
        } : {}),
      };
    }
    case 'expand_evidence': {
      const evidence = ledger.get(action.evidenceId);
      if (!evidence) throw new Error('只能扩展本轮已有证据。');
      const range = tools.readNoteRange({
        lineFrom: Math.max(1, evidence.lineFrom - action.beforeLines),
        lineTo: Math.min(snapshot.lineCount, evidence.lineTo + action.afterLines),
      }, readLimits);
      return evidenceObservation({ snapshot, ledger, coverageLedger, goalId, toolCallId, question, budget, blockIds: range.blockIds, headingPath: evidence.headingPath, lineFrom: range.lineFrom, lineTo: range.lineTo, text: range.text, label: '扩展证据', admission: 'expanded-read', nextCursor: range.nextCursor });
    }
  }
}

function evidenceObservation(input: {
  snapshot: CurrentNoteSnapshot;
  ledger: CurrentNoteEvidenceLedger;
  coverageLedger: CurrentNoteSearchCoverageLedger;
  goalId: string | undefined;
  toolCallId: string;
  question: string;
  budget: CurrentNoteAgentBudget;
  blockIds: string[];
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  label: string;
  admission?: 'explicit-read' | 'expanded-read';
  headingId?: string;
  nextCursor?: number;
}): ToolObservation {
  if (input.text.length > input.budget.maxSingleObservationChars) throw new Error('单次原文读取超过本轮观察上限。');
  const result = input.ledger.add({
    blockIds: input.blockIds,
    headingPath: input.headingPath,
    lineFrom: input.lineFrom,
    lineTo: input.lineTo,
    text: input.text,
    matchedTerms: [],
    supports: [input.question],
    sourceToolCallId: input.toolCallId,
    admission: input.admission ?? 'explicit-read',
  });
  input.coverageLedger.recordRead(input.goalId, {
    snapshotId: input.snapshot.snapshotId,
    evidenceId: result.record.evidenceId,
    blockIds: result.record.blockIds,
    headingPath: result.record.headingPath,
    lineFrom: result.record.lineFrom,
    lineTo: result.record.lineTo,
    text: result.record.text,
    ...(input.headingId ? { headingId: input.headingId } : {}),
    ...(input.nextCursor !== undefined ? { nextCursor: input.nextCursor } : {}),
  });
  return {
    summary: `${input.label}已写入 Evidence Ledger：${result.record.evidenceId} L${result.record.lineFrom}-L${result.record.lineTo}${input.nextCursor ? `，nextCursor=${input.nextCursor}` : ''}`,
    publicMessage: `已读取 ${input.label}原文（L${result.record.lineFrom}-L${result.record.lineTo}）${input.nextCursor ? `，可从第 ${input.nextCursor} 行继续。` : ''}。`,
    detailedOutput: {
      evidenceId: result.record.evidenceId,
      snapshotId: input.snapshot.snapshotId,
      headingPath: result.record.headingPath,
      lineFrom: result.record.lineFrom,
      lineTo: result.record.lineTo,
      blockIds: result.record.blockIds,
      text: result.record.text,
      added: result.added,
      ...(input.nextCursor !== undefined ? { nextCursor: input.nextCursor } : {}),
    },
    contentPreviews: [createToolContentPreview('evidence', result.record.headingPath, result.record.lineFrom, result.record.lineTo, result.record.text)],
    evidenceId: result.record.evidenceId,
    evidenceAdded: result.added,
    searchedBlocks: 0,
    readCharacters: result.record.text.length,
    emptySearch: false,
    ...(input.nextCursor !== undefined ? { nextCursor: input.nextCursor } : {}),
  };
}

const MAX_PUBLIC_TOOL_CONTENT_PREVIEWS = 6;
const MAX_PUBLIC_TOOL_CONTENT_PREVIEW_CHARS = 2_400;

function createSearchContentPreviews(hits: readonly CurrentNoteSearchHit[]): CurrentNotePublicToolContentPreview[] {
  return hits.slice(0, MAX_PUBLIC_TOOL_CONTENT_PREVIEWS).map((hit) => createToolContentPreview(
    'candidate',
    hit.headingPath,
    hit.lineFrom,
    hit.lineTo,
    hit.snippet,
  ));
}

function createToolContentPreview(
  kind: CurrentNotePublicToolContentPreview['kind'],
  headingPath: readonly string[],
  lineFrom: number,
  lineTo: number,
  text: string,
): CurrentNotePublicToolContentPreview {
  const truncated = text.length > MAX_PUBLIC_TOOL_CONTENT_PREVIEW_CHARS;
  return {
    kind,
    headingPath: headingPath.slice(0, 8).map((part) => part.slice(0, 240)),
    lineFrom,
    lineTo,
    text: truncated ? `${text.slice(0, MAX_PUBLIC_TOOL_CONTENT_PREVIEW_CHARS).trimEnd()}\n…` : text,
    truncated,
  };
}

function recordExecutionTrace(
  state: AgentState,
  kind: 'action' | 'observation' | 'correction',
  goalId: string | undefined,
  tool: string,
  summary: string,
  evidenceIds: readonly string[],
): void {
  const plan = state.searchPlan;
  if (!plan || !goalId) return;
  state.traceStore.record({ planId: plan.planId, planVersion: plan.version, goalId, kind, tool, summary, evidenceIds });
}

function recordProgress(state: AgentState, observation: { evidenceAdded: boolean; emptySearch: boolean; searchSet?: string }, budget: CurrentNoteAgentBudget): void {
  // An empty result is still useful feedback for the next ReAct decision. It
  // consumes one shared tool call, but it must not introduce an earlier cap.
  if (!observation.emptySearch && observation.searchSet !== undefined) {
    if (state.searchResultSets.has(observation.searchSet)) state.noProgressCount += 1;
    state.searchResultSets.add(observation.searchSet);
  } else if (observation.evidenceAdded) {
    state.noProgressCount = 0;
  }
  if (state.noProgressCount >= budget.maxNoProgressRounds) state.stopReason = 'no-progress';
}

function hydrateMemoryEvidence(ledger: CurrentNoteEvidenceLedger, snapshot: CurrentNoteSnapshot, records: CurrentNoteEvidenceRecord[]): number {
  let hydratedCount = 0;
  for (const record of records) {
    if (record.snapshotId !== snapshot.snapshotId || record.contentHash !== snapshot.contentHash) continue;
    ledger.add({
      blockIds: record.blockIds,
      headingPath: record.headingPath,
      lineFrom: record.lineFrom,
      lineTo: record.lineTo,
      text: record.text,
      matchedTerms: record.matchedTerms,
      supports: record.supports,
      sourceToolCallId: 'memory-reuse',
      admission: 'memory-reuse',
    });
    hydratedCount += 1;
  }
  return hydratedCount;
}

function toCoverageReadInput(record: CurrentNoteEvidenceRecord): CurrentNoteCoverageReadInput {
  return {
    snapshotId: record.snapshotId,
    evidenceId: record.evidenceId,
    blockIds: record.blockIds,
    headingPath: record.headingPath,
    lineFrom: record.lineFrom,
    lineTo: record.lineTo,
    text: record.text,
  };
}

function composeDecisionPrompt(
  stablePrefix: string,
  question: string,
  conversation: AssistantConversationMessage[],
  ledger: CurrentNoteEvidenceLedger,
  state: AgentState,
  projectionLevel: PromptProjectionLevel = 0,
): PromptProjection {
  const planAware = state.searchPlan !== undefined;
  const coverageSummary = state.searchPlan?.activeGoalId
    ? coverageSummaryForGoal(state, state.searchPlan.activeGoalId)
    : state.coverageLedger.toSummary(1);
  const actionRules = planAware
    ? `计划模式下每个工具动作必须包含 goalId，且等于 plan 摘要中的 activeGoalId；每轮只输出一个工具。planPatch 只用于尽力同步 SearchPlan 展示，必须带 baseVersion；没有实际计划变化或无法形成有效补丁时必须为 null，禁止提交空 goalUpdates 或复写当前值。导航工具不得把目标标为 covered；只有读取正文后才能提交 partial、covered 或 conflicted。queryVariants 只能在搜索为空、覆盖不足或出现新标题/术语后追加，必须通过 goalUpdates.queryVariants 提交；QueryTerm 累计数量不设业务上限，控制器每次只执行 ${CURRENT_NOTE_SEARCH_TERM_LIMIT} 个并按稳定顺序推进批次。note-map、search-observation、user-confirmed 只能使用当前作用域可证明的词，模型同义词标记 model-synonym。answer 可携带最后一个 planPatch，但 planPatch 是否可同步不影响 answer 的接受和结束。`
    : '工具失败时，先根据观察中的纠正格式重试，不要立即声称证据不足。';
  const sectionCursorRule = state.sectionNextCursors.size
    ? `当前允许继续读取的章节游标：${[...state.sectionNextCursors.entries()].map(([headingId, cursor]) => `${headingId}=${cursor}`).join('；')}。读取新章节时 JSON 中 cursor 必须为 null。`
    : '当前没有可用的章节 nextCursor；首次读取任何章节时 JSON 中 cursor 必须为 null。';
  const searchCursorRule = planAware
    ? state.searchNextCursors.size
      ? `当前允许继续搜索的主进程 cursor：${[...state.searchNextCursors.entries()].map(([goalId, cursor]) => `${goalId}=${cursor}`).join('；')}；只有同一规范化查询、范围模式、当前快照和排序版本可以继续使用。新查询的 JSON cursor 必须为 null。`
      : '当前没有可用的 search_note nextCursor；Plan 首次搜索时 JSON 中 cursor 必须为 null，不能自行猜测。'
    : '非 Plan 路径的 search_note JSON 中 cursor 必须为 null。';
  const correctionDetails = state.lastActionFailureDetails?.length
    ? `具体违反项：${state.lastActionFailureDetails.join('；')}。`
    : '';
  const correctionRule = state.lastActionFailureCode
    && state.lastActionFailureCode !== 'context-overflow'
    && state.lastActionFailureCode !== 'provider-timeout'
    && state.decisionRepairCount <= 1
    ? `上一工具动作无法执行。${correctionDetails}如果仍需调用工具，请严格按上方工具结构重新输出；否则直接给出最终回答。`
    : '';
  const toolCapabilityPrompt = renderToolCapabilityPrompt({
    source: 'current-note',
    activePhases: resolveCurrentNoteToolPhases(state, ledger),
  });
  const conversationSearchPrompt = state.conversationSearchEnabled
    ? '\n[当前额外激活工具]\n- search_conversations(query:string, limit:1-8)：按需搜索其他已完成会话的历史原话；不能把结果当作知识库事实证据。'
    : '';
  const projection = new PlanAwarePromptProjector(state.traceStore).build({
    callKind: 'decide',
    stablePrefix,
    question,
    conversation,
    plan: state.searchPlan,
    baseVersion: state.searchPlan?.version,
    evidence: ledger.list(),
    traceStore: state.traceStore,
    projectionLevel,
    recentEvidenceIds: [...(state.goalEvidenceIds.get(state.searchPlan?.activeGoalId ?? '') ?? [])].slice(-2),
    latestEvidenceObservations: resolveCurrentGoalLatestEvidenceObservations(state, ledger),
    outputSchema: createCurrentNoteDecideJsonSchema(state.conversationSearchEnabled),
    contextRuntime: currentNotePromptRuntime(state),
    rulesText: `建议只输出一个 JSON 对象。\n${toolCapabilityPrompt}${conversationSearchPrompt}\nread_note_section arguments 只允许 headingId、cursor；首次读取章节把 cursor 写为 null，主进程会在执行前移除该占位值；只有继续读取同一章节时才能填写该工具上一次返回的 nextCursor。cursor 是从 1 开始的绝对 Markdown 行号，不是页码、章节序号或从 0 开始的索引，禁止自行猜测。${sectionCursorRule}${searchCursorRule}工具返回的正文由主进程从当前笔记快照读取；你自行判断是否继续调用工具。Decision 的 answer 只表示停止检索，answer 正文不会直接作为最终回答；最终正文、citations、completeness 和 planPatch 统一由后续 Synthesize 基于当前 goal 的证据生成。Decision citations 可填写已提供的 evidenceId，也可以为空，仅用于候选排序，不会直接成为最终引用。Coverage 摘要仅供检索决策，不能写入或改写：${JSON.stringify(coverageSummary)}。${actionRules}${correctionRule ? ` ${correctionRule}` : ''}`,
  });
  state.lastPromptStats = projection.promptStats;
  state.highestProjectionLevel = Math.max(state.highestProjectionLevel, projection.compactionLevel) as PromptProjectionLevel;
  return projection;
}

function resolveCurrentNoteToolPhases(state: AgentState, ledger: CurrentNoteEvidenceLedger): ToolCapabilityPhase[] {
  const phases: ToolCapabilityPhase[] = ['navigation'];
  // Planner 路径先导航后读取；无 Planner 的直接 ReAct 路径已持有 Note
  // Capsule，可从其中的受控 headingId/行号开始读取，保持原有能力边界。
  if (!state.searchPlan || state.toolCalls > 0 || ledger.list().length > 0) phases.push('reading');
  if (ledger.list().length > 0) phases.push('evidence-extension');
  return phases;
}

interface ComposedAnswerPrompt {
  prompt: string;
  projection: PromptProjection;
  evidencePromptManifest?: EvidencePromptManifest;
}

function composeAnswerPrompt(
  stablePrefix: string,
  question: string,
  ledger: CurrentNoteEvidenceLedger,
  contextMode: string,
  searchPlan?: SearchPlan,
  state?: AgentState,
  projectionLevel: PromptProjectionLevel = 0,
  options: {
    candidateEvidenceIds?: readonly string[];
    repairMessage?: string;
    answerDepth?: AssistantAnswerDepth;
    assistantEvidenceProjectionMode?: AssistantEvidenceProjectionMode;
    evidenceCompressionMode?: EvidenceCompressionMode;
    maxPromptTokens?: number;
    snapshotId?: string;
    contentHash?: string;
    compressedArtifacts?: readonly EvidenceCompressionArtifact[];
    compressionRounds?: number;
  } = {},
): ComposedAnswerPrompt {
  const coverageSummary = state
    ? (state.searchPlan?.activeGoalId ? coverageSummaryForGoal(state, state.searchPlan.activeGoalId) : state.coverageLedger.toSummary(1))
    : undefined;
  const projection = new PlanAwarePromptProjector(state?.traceStore).build({
    callKind: 'synthesize',
    stablePrefix,
    question,
    plan: searchPlan,
    evidence: ledger.list(),
    candidateEvidenceIds: options.candidateEvidenceIds,
    projectionLevel,
    outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
    assistantEvidenceProjectionMode: options.assistantEvidenceProjectionMode,
    evidenceCompressionMode: options.evidenceCompressionMode,
    maxPromptTokens: options.maxPromptTokens,
    snapshotId: options.snapshotId,
    contentHash: options.contentHash,
    compressedArtifacts: options.compressedArtifacts,
    compressionRounds: options.compressionRounds,
    ...(state ? { contextRuntime: currentNotePromptRuntime(state) } : {}),
    rulesText: `当前模式：${contextMode}。基于提示词中提供的当前笔记正文生成答案，不得猜测未提供内容；由你自行决定何时结束以及 completeness。${formatAnswerDepthRules(options.answerDepth ?? 'auto')} 建议使用上方 answer JSON 结构，但任何模型输出都会直接作为最终回答，本地不会做格式纠错、证据门槛校验或替代回答。citations 可填写已提供的 evidenceId，也可以为空，只用于界面原文定位。planPatch 只同步 SearchPlan 展示，不决定答案是否接受；没有实际计划变化时可以不提供。${options.assistantEvidenceProjectionMode === 'all-retrieved' && (options.evidenceCompressionMode === 'off' || options.evidenceCompressionMode === 'enforce') ? '最终合成基于全部已检索内容；未压缩部分使用原文，压缩部分使用带原 evidenceId 的压缩单元；candidateEvidenceIds 仅标记重点，不得排除其他已检索内容。' : '最终合成依据已投影的当前笔记原文与 Coverage 摘要。'}Coverage 摘要（只读，仅供判断检索范围）：${JSON.stringify(coverageSummary ?? {})}。${options.assistantEvidenceProjectionMode === 'all-retrieved' && options.evidenceCompressionMode !== 'off' && options.candidateEvidenceIds ? '' : options.candidateEvidenceIds ? `本轮重点 evidenceId：${options.candidateEvidenceIds.join(',') || 'none'}。` : ''}${options.repairMessage ? ` ${options.repairMessage}` : ''}`,
  });
  if (state) {
    state.lastPromptStats = projection.promptStats;
    state.highestProjectionLevel = Math.max(state.highestProjectionLevel, projection.compactionLevel) as PromptProjectionLevel;
  }
  return {
    prompt: projection.prompt,
    projection,
    ...(projection.evidencePromptManifest ? { evidencePromptManifest: projection.evidencePromptManifest } : {}),
  };
}

function actionSignature(snapshotId: string, action: Extract<CurrentNoteAgentAction, { type: 'tool' }>): string {
  return createHash('sha256').update(`${snapshotId}\u0000${action.goalId ?? ''}\u0000${action.tool}\u0000${stableJson(action.arguments)}\u0000${stableJson(action.planPatch)}`, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('工具参数包含不允许的字段。');
}

function readInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label}必须是整数。`);
  return value as number;
}

function readBoundedInteger(value: unknown, label: string, min: number, max: number): number {
  const result = readInteger(value, label);
  if (result < min || result > max) throw new Error(`${label}必须在 ${min} 到 ${max} 之间。`);
  return result;
}
