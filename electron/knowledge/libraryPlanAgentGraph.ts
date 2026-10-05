import { createHash } from 'node:crypto';
import type { AiProviderKind } from './aiTypes';
import type { AssistantConversationMessage, AssistantEvidenceCitation, CurrentNoteAgentStats, CurrentNotePublicPlanEvent, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, CurrentNoteToolStats, LibrarySectionNavigationObservation } from './assistantTurnTypes';
import { estimateAssistantContextUsage, estimateTokenCount, type AssistantContextUsage, type AssistantPromptStats, type AssistantTokenUsage } from './tokenEstimator';
import { tokenizeCurrentNoteText } from './currentNoteStructure';
import { DEFAULT_CURRENT_NOTE_AGENT_BUDGET, type CurrentNoteAgentBudget } from './currentNoteAgentGraph';
import { createFallbackLibraryPlan, createLibraryPlanCapsule, libraryPlanToolDescriptions, type LibraryPlanDriver } from './libraryPlanDriver';
import { createLibraryNoteTools, searchLibraryNoteCandidates, type LibraryNoteCandidate, type LibraryNoteReadLimits, type LibrarySearchCallbacks } from './libraryNoteTools';
import { LibraryEvidenceLedger, type LibraryEvidenceRecord } from './libraryEvidenceLedger';
import { type LibraryNoteSnapshotMap, type LibraryNoteSnapshotRecord } from './libraryNoteSnapshot';
import {
  LIBRARY_DECIDE_JSON_SCHEMA,
  LIBRARY_SYNTHESIZE_JSON_SCHEMA,
  type LibraryAgentAction,
  type LibraryStructuredActionDriver,
} from './libraryStructuredActionDriver';
import { applySearchPlanAnswerAction, applySearchPlanPatch, isSearchGoalExecutable, markSearchPlanStale, setSearchPlanControllerStatus } from './searchPlanValidation';
import type { QueryVariant, SearchPlan, SearchPlanAnswerAction } from './searchPlanTypes';
import { ModelCallBudgetGate, type ModelCallTicket } from './modelCallBudget';
import { PromptBudgetScheduler, type PromptCallKind, type PromptBudgetPlan } from './currentNoteContextBudget';
import { isAiContextOverflow } from './aiProviderError';
import { PlanExecutionTraceStore } from './planExecutionTraceStore';
import { DEFAULT_PLAN_JSON_SCHEMA, PlanAwarePromptProjector, toStructuredOutputSchema } from './planAwarePromptProjector';
import type { AdaptiveContextMode } from './assistantMode';
import type { ModelCallCoordinator } from './modelCallCoordinator';
import { sharedTokenCalibrationStore, type TokenCalibrationStore } from './tokenCalibration';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS } from '../../shared/assistantContextBudget';
import { projectPublicSearchPlan, sanitizeQueryTerms } from './publicSearchPlan';
import type { AssistantDetailedTraceSink } from './assistantDetailedTrace';
import {
  createLibrarySectionExclusionFingerprint,
  type LibrarySectionRankResult,
  type LibrarySectionRecommendationObservation,
} from './librarySectionRanker';

export type LibrarySectionRankShadowMode = 'off' | 'observe';
export type LibrarySectionNavigationMode = 'off' | 'observe';

export interface LibrarySectionRankShadowDiagnostic {
  schemaVersion: 'library-section-rank-shadow-v1';
  sourceTool: 'read_library_note_range' | 'read_library_note_section' | 'read_library_adjacent_section';
  goalId: string;
  noteId: string;
  snapshotId: string;
  queryTermCount: number;
  evaluatedSectionCount: number;
  top3Ids: string[];
  ambiguous: boolean;
  fallbackUsed: boolean;
  cacheHit: boolean;
  elapsedMs: number;
}

export interface LibraryPlanAgentResult {
  answer: string;
  evidence: AssistantEvidenceCitation[];
  sourceNotes: LibraryNoteCandidate[];
  completeness: 'complete' | 'partial' | 'not-found';
  toolStats: CurrentNoteToolStats;
  agentStats: CurrentNoteAgentStats;
  prefixFingerprint: string;
  contextUsage: AssistantContextUsage;
  searchPlan?: SearchPlan;
}

export interface LibraryPlanAgentInput {
  snapshotMap: LibraryNoteSnapshotMap;
  sessionId: string;
  question: string;
  conversation: AssistantConversationMessage[];
  providerKind: AiProviderKind;
  model: string;
  contextWindowTokens?: number;
  signal: AbortSignal;
  planner: LibraryPlanDriver;
  driver: LibraryStructuredActionDriver;
  search: LibrarySearchCallbacks;
  isSnapshotCurrent: () => boolean;
  onToolEvent?: (event: CurrentNotePublicToolEvent) => void;
  onPlanEvent?: (event: CurrentNotePublicPlanEvent) => void;
  /** Main-process-only JSONL sink. Only the bounded Stage 3 segment may project navigation candidates. */
  onDetailedTrace?: AssistantDetailedTraceSink;
  /** Stage 2 rollout gate. Production opts in explicitly from the main process. */
  sectionRankShadowMode?: LibrarySectionRankShadowMode;
  /** Stage 3 rollout gate. Recommendations remain navigation-only Prompt observations. */
  sectionRankNavigationMode?: LibrarySectionNavigationMode;
  /** A turn-level gate supplied by main; absent means a standalone fixture gate. */
  modelCallGate?: ModelCallBudgetGate;
  modelCallCoordinator?: ModelCallCoordinator;
  adaptiveContextMode?: AdaptiveContextMode;
  tokenCalibrationStore?: TokenCalibrationStore;
  budget?: CurrentNoteAgentBudget;
}

interface LibraryAgentState {
  decisionRounds: number;
  modelCalls: number;
  toolCalls: number;
  invalidActionCount: number;
  noProgressCount: number;
  searchedBlocks: number;
  readCharacters: number;
  elapsedMs: number;
  stopReason?: CurrentNoteAgentStats['stopReason'];
  actionProgress: Map<string, boolean>;
  searchResultSets: Set<string>;
  discoveredNoteIds: Set<string>;
  candidates: Map<string, LibraryNoteCandidate>;
  variantGates: Map<string, VariantGate>;
  userConfirmedTerms: Set<string>;
  searchPlan?: SearchPlan;
  lastQueryTerms?: string[];
  modelCallGate: ModelCallBudgetGate;
  traceStore: PlanExecutionTraceStore;
  lastPromptPlan?: PromptBudgetPlan;
  lastPromptStats?: AssistantPromptStats;
  highestProjectionLevel: 0 | 1 | 3 | 4;
  sectionRankShadowResults: Map<string, LibrarySectionRankResult>;
  navigationObservationsByGoal: Map<string, LibrarySectionRecommendationObservation>;
  readHeadingIdsByGoal: Map<string, Map<string, Set<string>>>;
}

interface VariantGate {
  signals: Set<'empty-search' | 'coverage-insufficient' | 'new-note-term'>;
  noteMapTerms: Set<string>;
  searchObservationTerms: Set<string>;
}

type ValidatedLibraryAction =
  | { tool: 'search_note_library'; limit: number }
  | { tool: 'get_library_note_map'; noteId: string; detail: 'outline' | 'stats' | 'terms' }
  | { tool: 'search_library_note_blocks'; noteId: string; limit: number }
  | { tool: 'read_library_note_range'; noteId: string; lineFrom: number; lineTo: number }
  | { tool: 'read_library_note_section'; noteId: string; headingId: string; cursor?: number }
  | { tool: 'expand_library_evidence'; evidenceId: string; beforeLines: number; afterLines: number }
  | { tool: 'read_library_adjacent_section'; evidenceId: string; direction: 'previous' | 'next' };

interface LibraryToolObservation {
  summary: string;
  publicMessage: string;
  evidenceAdded: boolean;
  searchedBlocks: number;
  readCharacters: number;
  emptySearch: boolean;
  searchSet?: string;
  variantTerms?: { source: 'note-map' | 'search-observation'; terms: string[] };
  contentPreviews?: CurrentNotePublicToolContentPreview[];
  sectionNavigation?: LibrarySectionNavigationObservation;
  sourceEvidenceId?: string;
}

const NAVIGATION_TOOLS = new Set<ValidatedLibraryAction['tool']>([
  'search_note_library',
  'get_library_note_map',
  'search_library_note_blocks',
]);
const READ_TOOLS = new Set<ValidatedLibraryAction['tool']>([
  'read_library_note_range',
  'read_library_note_section',
  'expand_library_evidence',
  'read_library_adjacent_section',
]);
const LIBRARY_TOOL_PREVIEW_CHARACTERS = 2_400;

const LIBRARY_DECIDE_STRUCTURED_OUTPUT = toStructuredOutputSchema('library_decide', LIBRARY_DECIDE_JSON_SCHEMA);
const LIBRARY_SYNTHESIZE_STRUCTURED_OUTPUT = toStructuredOutputSchema('library_synthesize', LIBRARY_SYNTHESIZE_JSON_SCHEMA);

/** Cross-note Plan-and-Execute runner. It shares the current-note hard budget. */
export async function runLibraryPlanAgent(input: LibraryPlanAgentInput): Promise<LibraryPlanAgentResult> {
  const budget = input.budget ?? DEFAULT_CURRENT_NOTE_AGENT_BUDGET;
  const startedAt = Date.now();
  if (input.snapshotMap.sessionId !== input.sessionId) throw new Error('整库计划不属于当前助手会话。');
  const state: LibraryAgentState = {
    decisionRounds: 0,
    modelCalls: 0,
    toolCalls: 0,
    invalidActionCount: 0,
    noProgressCount: 0,
    searchedBlocks: 0,
    readCharacters: 0,
    elapsedMs: 0,
    actionProgress: new Map(),
    searchResultSets: new Set(),
    discoveredNoteIds: new Set(),
    candidates: new Map(),
    variantGates: new Map(),
    userConfirmedTerms: collectUserTerms(input.question, input.conversation),
    modelCallGate: input.modelCallGate ?? new ModelCallBudgetGate({ maxModelCalls: budget.maxModelCalls, maxWallTimeMs: budget.maxWallTimeMs, startedAt }),
    traceStore: new PlanExecutionTraceStore(),
    highestProjectionLevel: 0,
    sectionRankShadowResults: new Map(),
    navigationObservationsByGoal: new Map(),
    readHeadingIdsByGoal: new Map(),
  };
  state.modelCalls = state.modelCallGate.modelCalls;
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  const ledger = new LibraryEvidenceLedger(input.snapshotMap, input.sessionId, budget.maxRawEvidenceChars);
  const tools = createLibraryNoteTools(input.snapshotMap, input.sessionId);
  const capsule = createLibraryPlanCapsule(input.snapshotMap);
  const prefix = createStablePrefix(input.providerKind, input.model, capsule);
  if (!input.isSnapshotCurrent() || input.snapshotMap.indexState === 'stale') {
    state.stopReason = 'snapshot-stale';
    state.searchPlan = createFallbackLibraryPlan(input.question);
    if (state.searchPlan) state.searchPlan = markSearchPlanStale(state.searchPlan);
    return finalize(input, prefix, ledger, state, '当前笔记库索引已更新，请重新提问。', 'partial');
  }

  const initialized = await initializePlan(input, capsule, state, budget, startedAt);
  if (initialized === 'clarify') return finalize(input, prefix, ledger, state, '请补充一个可定位笔记库内容的关键词或具体问题。', 'partial');
  if (initialized === 'stale') {
    if (state.searchPlan) state.searchPlan = markSearchPlanStale(state.searchPlan);
    return finalize(input, prefix, ledger, state, '笔记库索引已更新，请重新提问。', 'partial');
  }
  emitPlanEvent(input, state, ledger, 'started');

  let answerAction: Extract<LibraryAgentAction, { type: 'answer' }> | undefined;
  while (true) {
    const decisionStop = beforeDecision(input, state, budget, startedAt);
    if (decisionStop) {
      state.stopReason = decisionStop;
      break;
    }
    state.decisionRounds += 1;
    const decisionPrompt = composeDecisionPrompt(prefix, input.question, input.conversation, state, ledger);
    const action = await runLibraryDecision(input, state, budget, decisionPrompt, prefix, input.question, input.conversation, ledger);
    if (!action) {
      if (state.stopReason === 'context-budget' || state.stopReason === 'timeout' || state.stopReason === 'max-model-calls') break;
      state.invalidActionCount += 1;
      if (state.invalidActionCount >= budget.maxInvalidActions) state.stopReason = 'invalid-action';
      if (state.stopReason) break;
      continue;
    }
    if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    if (!input.isSnapshotCurrent()) {
      state.stopReason = 'snapshot-stale';
      break;
    }
    if (action.type === 'answer') {
      answerAction = action;
      state.stopReason = 'answered';
      break;
    }
    const signature = actionSignature(state.searchPlan, action);
    if (state.actionProgress.get(signature) === false) {
      state.stopReason = 'repeated-action';
      break;
    }
    const toolStop = beforeTool(input, state, budget, startedAt);
    if (toolStop) {
      state.stopReason = toolStop;
      break;
    }
    const validated = validateLibraryAction(action);
    let deferredPatch = false;
    try {
      if (!state.searchPlan) throw new Error('整库 SearchPlan 不存在。');
      deferredPatch = READ_TOOLS.has(validated.tool)
        && (hasUnseenEvidencePatch(action.planPatch, ledger)
          || Boolean(action.planPatch?.goalUpdates.some((update) => update.status === 'partial' || update.status === 'covered' || update.status === 'conflicted')));
      if (deferredPatch && (action.planPatch?.activeGoalId !== undefined || action.planPatch?.goalOrder !== undefined)) {
        throw new Error('读取新证据时不能同时切换 activeGoalId 或 goalOrder。');
      }
      if (action.planPatch && !deferredPatch) applyActionPatch(state, action, ledger);
      ensureActionGoal(state.searchPlan, action.goalId);
      if (state.searchPlan.goals.find((goal) => goal.goalId === action.goalId)?.status === 'pending') startActiveGoal(state, ledger);
      ensureActionGoal(state.searchPlan, action.goalId);
      if (validated.tool === 'search_note_library' || validated.tool === 'search_library_note_blocks') {
        const activeGoal = state.searchPlan.goals.find((goal) => goal.goalId === state.searchPlan?.activeGoalId);
        state.lastQueryTerms = activeGoal ? sanitizeQueryTerms(activeGoal.queryTerms.map((queryTerm) => queryTerm.term)) : undefined;
      }
    } catch (error) {
      registerInvalid(state, budget, error);
      if (state.stopReason) break;
      continue;
    }

    const toolCallId = `library-tool-${state.toolCalls + 1}`;
    state.toolCalls += 1;
    recordExecutionTrace(state, 'action', action.goalId, action.tool, `已请求工具 ${action.tool}`, []);
    const inputSummary = summarizeLibraryToolInput(validated);
    emitTool(input, { tool: validated.tool, state: 'started', message: action.publicRationale, inputSummary });
    const toolStartedAt = Date.now();
    const evidenceBefore = new Set(ledger.list().map((record) => record.evidenceId));
    try {
      const observation = await executeLibraryTool(input, validated, state, tools, ledger, toolCallId, budget);
      const elapsedMs = Date.now() - toolStartedAt;
      state.elapsedMs += elapsedMs;
      state.searchedBlocks += observation.searchedBlocks;
      state.readCharacters += observation.readCharacters;
      state.actionProgress.set(signature, observation.evidenceAdded);
      if (action.planPatch && deferredPatch) applyActionPatch(state, action, ledger);
      recordExecutionTrace(state, 'observation', action.goalId, action.tool, observation.summary, ledger.list().map((record) => record.evidenceId).filter((evidenceId) => !evidenceBefore.has(evidenceId)));
      recordVariantSignals(state, action.goalId, observation, input);
      emitTool(input, {
        tool: validated.tool,
        state: 'completed',
        message: observation.publicMessage,
        inputSummary,
        outputSummary: observation.publicMessage,
        ...(observation.contentPreviews?.length ? { contentPreviews: observation.contentPreviews } : {}),
        ...(observation.sectionNavigation ? { sectionNavigation: observation.sectionNavigation } : {}),
        elapsedMs,
      });
      emitPlanEvent(input, state, ledger, 'updated');
      recordProgress(state, observation, budget);
      if (!input.isSnapshotCurrent()) {
        state.stopReason = 'snapshot-stale';
        break;
      }
      if (state.stopReason) break;
      // Keep a no-op read from being used to burn the complete budget.
      if (evidenceBefore.size === ledger.list().length && !observation.evidenceAdded && state.noProgressCount >= budget.maxNoProgressRounds) {
        state.stopReason = 'no-progress';
        break;
      }
    } catch (error) {
      const elapsedMs = Date.now() - toolStartedAt;
      state.elapsedMs += elapsedMs;
      state.actionProgress.set(signature, false);
      state.invalidActionCount += 1;
      state.noProgressCount += 1;
      const message = error instanceof Error ? error.message : '工具执行失败。';
      const summary = `工具 ${validated.tool} 执行失败；请根据参数约束重试。`;
      recordExecutionTrace(state, 'correction', action.goalId, validated.tool, summary, []);
      emitTool(input, { tool: validated.tool, state: 'rejected', message, inputSummary, elapsedMs });
      if (state.invalidActionCount >= budget.maxInvalidActions || state.noProgressCount >= budget.maxNoProgressRounds) state.stopReason = state.invalidActionCount >= budget.maxInvalidActions ? 'invalid-action' : 'no-progress';
      if (state.stopReason) break;
    }
  }

  state.stopReason ??= state.toolCalls >= budget.maxToolCalls ? 'max-tool-calls' : 'max-decision-rounds';
  const finalAction = answerAction ?? (state.stopReason === 'snapshot-stale'
    ? {
      type: 'answer' as const,
      answer: '笔记库索引已更新，请重新提问。',
      citations: ledger.list().map((record) => record.evidenceId),
      completeness: 'partial' as const,
    }
    : await synthesizeOrFallback(input, prefix, state, ledger, budget, startedAt));
  let finalAnswer = finalAction.answer;
  let completeness = finalAction.completeness;
  if (state.searchPlan) {
    if (state.stopReason === 'snapshot-stale') {
      state.searchPlan = markSearchPlanStale(state.searchPlan);
      completeness = 'partial';
    } else {
      const committed = commitAnswer(state, finalAction, ledger);
      if (!committed) {
        state.stopReason = 'invalid-action';
        finalAnswer = '当前整库检索尚未取得足够的、可相互核对的原文证据，以下仅作为部分结果。';
        completeness = ledger.list().length ? 'partial' : 'not-found';
        if (state.searchPlan.status === 'active') state.searchPlan = setSearchPlanControllerStatus(state.searchPlan, completeness === 'not-found' ? 'not-found' : 'partial');
      } else if (completeness === 'complete' && state.searchPlan.status === 'active') {
        state.searchPlan = setSearchPlanControllerStatus(state.searchPlan, 'completed');
      } else if (state.searchPlan.status === 'active') {
        state.searchPlan = setSearchPlanControllerStatus(state.searchPlan, completeness === 'not-found' ? 'not-found' : 'partial');
      }
    }
  }
  emitPlanEvent(input, state, ledger, 'finished');
  return finalize(input, prefix, ledger, state, finalAnswer, completeness);
}

async function initializePlan(input: LibraryPlanAgentInput, capsule: ReturnType<typeof createLibraryPlanCapsule>, state: LibraryAgentState, budget: CurrentNoteAgentBudget, startedAt: number): Promise<'ready' | 'clarify' | 'stale'> {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent() || input.snapshotMap.indexState === 'stale') return 'stale';
  if (budget.maxModelCalls - state.modelCalls <= 1) {
    state.searchPlan = createFallbackLibraryPlan(input.question);
    return state.searchPlan ? 'ready' : 'clarify';
  }
  state.decisionRounds += 1;
  const prompt = new PlanAwarePromptProjector(state.traceStore).build({
    callKind: 'plan',
    stablePrefix: '[固定 Planner 策略]\n你是Trellora整库检索的结构化 Planner。只规划可由库内原文验证的证据目标，不回答问题，不执行工具。',
    capsuleText: JSON.stringify({ libraryId: capsule.libraryId, indexState: capsule.indexState, notes: capsule.notes }),
    question: input.question,
    conversation: input.conversation,
    toolInstructions: libraryPlanToolDescriptions,
    outputSchema: DEFAULT_PLAN_JSON_SCHEMA,
    rulesText: 'comparison 目标至少包含两个不同 subject 的 requirement；最多返回 4 个目标。',
  }).prompt;
  const prepared = prepareLibraryModelCall(input, state, budget, 'plan', prompt);
  if (!prepared) {
    state.searchPlan = createFallbackLibraryPlan(input.question);
    return state.searchPlan ? 'ready' : 'clarify';
  }
  try {
    state.searchPlan = await input.planner.plan({ capsule, question: input.question, conversation: input.conversation, signal: input.signal, prompt, maxOutputTokens: prepared.plan.maxOutputTokens, onUsage: observeLibraryModelUsage(input, state, 'plan', prompt) });
  } catch (error) {
    if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    if (isAiContextOverflow(error)) {
      // Planner overflow has no retry slot. The local fallback is the only
      // safe recovery and must not consume another ticket.
      state.stopReason = 'context-budget';
    }
    state.invalidActionCount += 1;
    state.searchPlan ??= createFallbackLibraryPlan(input.question);
  }
  if (!input.isSnapshotCurrent()) return 'stale';
  if (hasWallTimeExpired(budget, startedAt)) state.stopReason = 'timeout';
  return state.searchPlan ? 'ready' : 'clarify';
}

function validateLibraryAction(action: Extract<LibraryAgentAction, { type: 'tool' }>): ValidatedLibraryAction {
  const args = action.arguments;
  const noteId = () => {
    if (typeof args.noteId !== 'string' || !/^note-[a-f0-9]{24}$/u.test(args.noteId)) throw new Error('noteId 格式无效。');
    return args.noteId;
  };
  const limit = () => args.limit === undefined ? 8 : boundedInteger(args.limit, 'limit', 1, 20);
  switch (action.tool) {
    case 'search_note_library':
      assertKeys(args, ['limit']);
      return { tool: action.tool, limit: limit() };
    case 'get_library_note_map':
      assertKeys(args, ['noteId', 'detail']);
      if (args.detail !== undefined && args.detail !== 'outline' && args.detail !== 'stats' && args.detail !== 'terms') throw new Error('笔记地图 detail 无效。');
      return { tool: action.tool, noteId: noteId(), detail: (args.detail ?? 'outline') as 'outline' | 'stats' | 'terms' };
    case 'search_library_note_blocks':
      assertKeys(args, ['noteId', 'limit']);
      return { tool: action.tool, noteId: noteId(), limit: limit() };
    case 'read_library_note_range':
      assertKeys(args, ['noteId', 'lineFrom', 'lineTo']);
      return { tool: action.tool, noteId: noteId(), lineFrom: integer(args.lineFrom, '起始行'), lineTo: integer(args.lineTo, '结束行') };
    case 'read_library_note_section':
      assertKeys(args, ['noteId', 'headingId', 'cursor']);
      if (typeof args.headingId !== 'string' || !args.headingId.trim() || args.headingId.length > 160) throw new Error('章节标识无效。');
      if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 1)) throw new Error('章节游标无效。');
      return { tool: action.tool, noteId: noteId(), headingId: args.headingId.trim(), ...(args.cursor === undefined ? {} : { cursor: args.cursor as number }) };
    case 'expand_library_evidence':
      assertKeys(args, ['evidenceId', 'beforeLines', 'afterLines']);
      if (typeof args.evidenceId !== 'string' || !/^evidence-[a-f0-9]{24}$/u.test(args.evidenceId)) throw new Error('证据标识无效。');
      return { tool: action.tool, evidenceId: args.evidenceId, beforeLines: args.beforeLines === undefined ? 20 : boundedInteger(args.beforeLines, '前置扩展行数', 0, 40), afterLines: args.afterLines === undefined ? 20 : boundedInteger(args.afterLines, '后置扩展行数', 0, 40) };
    case 'read_library_adjacent_section':
      assertKeys(args, ['evidenceId', 'direction']);
      if (typeof args.evidenceId !== 'string' || !/^evidence-[a-f0-9]{24}$/u.test(args.evidenceId)) throw new Error('证据标识无效。');
      if (args.direction !== 'previous' && args.direction !== 'next') throw new Error('相邻章节方向无效。');
      return { tool: action.tool, evidenceId: args.evidenceId, direction: args.direction };
  }
}

async function executeLibraryTool(input: LibraryPlanAgentInput, action: ValidatedLibraryAction, state: LibraryAgentState, tools: ReturnType<typeof createLibraryNoteTools>, ledger: LibraryEvidenceLedger, toolCallId: string, budget: CurrentNoteAgentBudget): Promise<LibraryToolObservation> {
  const plan = state.searchPlan;
  if (!plan?.activeGoalId) throw new Error('当前计划没有 activeGoalId。');
  const goal = plan.goals.find((candidate) => candidate.goalId === plan.activeGoalId);
  if (!goal) throw new Error('当前 activeGoal 不存在。');
  const terms = goal.queryTerms.map((term) => term.term);
  switch (action.tool) {
    case 'search_note_library': {
      const query = terms.join(' ');
      const outcome = await searchLibraryNoteCandidates({ snapshotMap: input.snapshotMap, sessionId: input.sessionId, query, limit: action.limit, callbacks: input.search });
      for (const candidate of outcome.results) {
        state.discoveredNoteIds.add(candidate.noteId);
        state.candidates.set(candidate.noteId, candidate);
      }
      const searchSet = outcome.results.map((candidate) => candidate.noteId).sort().join(',');
      const observationTerms = outcome.results.flatMap((candidate) => [candidate.title, ...(candidate.matchTrace?.filter((trace) => trace.matchType !== 'fuzzy').map((trace) => trace.matchedTerm) ?? [])]);
      return {
        summary: outcome.results.length ? `候选：${outcome.results.map((candidate) => `${candidate.noteId}《${candidate.title}》`).join('；')}` : '整库搜索未召回候选笔记。',
        publicMessage: outcome.results.length ? `已找到 ${outcome.results.length} 篇候选笔记。` : '未找到候选笔记。',
        evidenceAdded: false,
        searchedBlocks: outcome.results.length,
        readCharacters: 0,
        emptySearch: outcome.results.length === 0,
        searchSet,
        ...(observationTerms.length ? { variantTerms: { source: 'search-observation', terms: observationTerms } } : {}),
      };
    }
    case 'get_library_note_map': {
      requireCandidate(state, action.noteId);
      const map = tools.getNoteMap(action.noteId, action.detail);
      const termsFromMap = [...(map.topTerms ?? []), ...map.headings.flatMap((heading) => [heading.text, ...heading.path])];
      return { summary: `地图：${action.noteId} ${map.headings.slice(0, 24).map((heading) => `${heading.headingId}@${heading.lineFrom}-${heading.lineTo}`).join('；')}`, publicMessage: '已读取候选笔记结构。', evidenceAdded: false, searchedBlocks: 0, readCharacters: 0, emptySearch: false, variantTerms: termsFromMap.length ? { source: 'note-map', terms: termsFromMap } : undefined };
    }
    case 'search_library_note_blocks': {
      requireCandidate(state, action.noteId);
      const hits = tools.searchNoteBlocks(action.noteId, terms, action.limit);
      const searchSet = hits.map((hit) => hit.blockId).sort().join(',');
      const observationTerms = hits.flatMap((hit) => [...hit.matchedTerms, ...hit.headingPath, ...hit.matchTrace.filter((trace) => trace.matchType !== 'fuzzy').map((trace) => trace.matchedTerm)]);
      return { summary: hits.length ? `块定位：${action.noteId} ${hits.map((hit) => `${hit.blockId}@${hit.lineFrom}-${hit.lineTo}`).join('；')}` : '候选笔记内未定位到匹配块。', publicMessage: hits.length ? `已定位到 ${hits.length} 个候选片段。` : '候选笔记内未找到匹配片段。', evidenceAdded: false, searchedBlocks: hits.length, readCharacters: 0, emptySearch: hits.length === 0, searchSet, ...(observationTerms.length ? { variantTerms: { source: 'search-observation', terms: observationTerms } } : {}) };
    }
    case 'read_library_note_range': {
      requireCandidate(state, action.noteId);
      const range = tools.readNoteRange(action.noteId, { lineFrom: action.lineFrom, lineTo: action.lineTo }, computeLibraryReadLimits(input, state, budget));
      const anchorHeadingId = tools.findDeepestHeadingIdAtLine(action.noteId, range.lineFrom);
      const observation = addLibraryEvidence(input, ledger, toolCallId, budget, action.noteId, range.blockIds, range.headingPath, range.lineFrom, range.lineTo, range.text, '行范围', range.nextCursor, anchorHeadingId);
      const sectionNavigation = runLibrarySectionRankShadow(input, state, tools, action.tool, action.noteId, observation.sourceEvidenceId, range.blockIds);
      return { ...observation, ...(sectionNavigation ? { sectionNavigation } : {}) };
    }
    case 'read_library_note_section': {
      requireCandidate(state, action.noteId);
      const section = tools.readNoteSection(action.noteId, { headingId: action.headingId, ...(action.cursor === undefined ? {} : { cursor: action.cursor }) }, computeLibraryReadLimits(input, state, budget));
      const observation = addLibraryEvidence(input, ledger, toolCallId, budget, action.noteId, section.blockIds, section.headingPath, section.lineFrom, section.lineTo, section.text, '章节', section.nextCursor, action.headingId);
      const sectionNavigation = runLibrarySectionRankShadow(input, state, tools, action.tool, action.noteId, observation.sourceEvidenceId, section.blockIds, [action.headingId]);
      return { ...observation, ...(sectionNavigation ? { sectionNavigation } : {}) };
    }
    case 'expand_library_evidence': {
      const evidence = ledger.get(action.evidenceId);
      if (!evidence) throw new Error('只能扩展本轮已有证据。');
      requireCandidate(state, evidence.noteId);
      const record = assertLibraryEvidenceCurrent(input, evidence);
      const lineFrom = Math.max(1, evidence.lineFrom - action.beforeLines);
      const lineTo = Math.min(record.localSnapshot.lineCount, evidence.lineTo + action.afterLines);
      const range = tools.readNoteRange(evidence.noteId, { lineFrom, lineTo }, computeLibraryReadLimits(input, state, budget));
      return addLibraryEvidence(input, ledger, toolCallId, budget, evidence.noteId, range.blockIds, evidence.headingPath, range.lineFrom, range.lineTo, range.text, '扩展证据', range.nextCursor, evidence.anchorHeadingId);
    }
    case 'read_library_adjacent_section': {
      const evidence = ledger.get(action.evidenceId);
      if (!evidence) throw new Error('只能从本轮已有证据读取相邻章节。');
      requireCandidate(state, evidence.noteId);
      assertLibraryEvidenceCurrent(input, evidence);
      if (!evidence.anchorHeadingId) throw new Error('当前证据没有可用的章节锚点。');
      const target = tools.findAdjacentSection(evidence.noteId, evidence.anchorHeadingId, action.direction);
      if (!target) {
        return {
          summary: `相邻同级章节 not-found：anchorHeadingId=${evidence.anchorHeadingId} direction=${action.direction}`,
          publicMessage: '当前证据在该方向没有相邻同级章节。',
          evidenceAdded: false,
          searchedBlocks: 0,
          readCharacters: 0,
          emptySearch: false,
        };
      }
      const section = tools.readNoteSection(target.noteId, { headingId: target.headingId }, computeLibraryReadLimits(input, state, budget));
      const observation = addLibraryEvidence(input, ledger, toolCallId, budget, target.noteId, section.blockIds, section.headingPath, section.lineFrom, section.lineTo, section.text, '相邻章节', section.nextCursor, target.headingId);
      const sectionNavigation = runLibrarySectionRankShadow(input, state, tools, action.tool, target.noteId, observation.sourceEvidenceId, section.blockIds, [target.headingId]);
      return {
        ...observation,
        ...(sectionNavigation ? { sectionNavigation } : {}),
        summary: `相邻同级章节：direction=${action.direction} headingId=${target.headingId}；${observation.summary}`,
      };
    }
  }
}

function addLibraryEvidence(_input: LibraryPlanAgentInput, ledger: LibraryEvidenceLedger, toolCallId: string, budget: CurrentNoteAgentBudget, noteId: string, _blockIds: string[], headingPath: string[], lineFrom: number, lineTo: number, text: string, label: string, nextCursor?: number, anchorHeadingId?: string) {
  if (text.length > budget.maxSingleObservationChars) throw new Error('单次原文读取超过本轮观察上限。');
  const result = ledger.add({ noteId, headingPath, ...(anchorHeadingId ? { anchorHeadingId } : {}), lineFrom, lineTo, text, matchedTerms: [], supports: [], sourceToolCallId: toolCallId });
  return {
    summary: `${label}已写入 Evidence Ledger：${result.record.evidenceId} ${result.record.noteId} L${result.record.lineFrom}-L${result.record.lineTo}${nextCursor ? ` nextCursor=${nextCursor}` : ''}`,
    publicMessage: `已读取 ${label}原文（${result.record.noteId} L${result.record.lineFrom}-L${result.record.lineTo}${nextCursor ? `，下一页从 ${nextCursor} 行开始` : ''}）。`,
    evidenceAdded: result.added,
    searchedBlocks: 0,
    readCharacters: result.record.text.length,
    emptySearch: false,
    sourceEvidenceId: result.record.evidenceId,
    contentPreviews: [createLibraryEvidencePreview(result.record)],
  };
}

function createLibraryEvidencePreview(record: LibraryEvidenceRecord): CurrentNotePublicToolContentPreview {
  return {
    kind: 'evidence',
    headingPath: [...record.headingPath],
    lineFrom: record.lineFrom,
    lineTo: record.lineTo,
    text: record.text.slice(0, LIBRARY_TOOL_PREVIEW_CHARACTERS),
    truncated: record.text.length > LIBRARY_TOOL_PREVIEW_CHARACTERS,
  };
}

function assertLibraryEvidenceCurrent(
  input: LibraryPlanAgentInput,
  evidence: LibraryEvidenceRecord,
): LibraryNoteSnapshotRecord {
  if (evidence.libraryId !== input.snapshotMap.libraryId) throw new Error('证据不属于当前资料库。');
  const record = input.snapshotMap.records.get(evidence.noteId);
  if (!record
    || record.snapshotId !== evidence.snapshotId
    || record.contentHash !== evidence.contentHash) {
    throw new Error('证据所属快照已过期。');
  }
  return record;
}

function runLibrarySectionRankShadow(
  input: LibraryPlanAgentInput,
  state: LibraryAgentState,
  tools: ReturnType<typeof createLibraryNoteTools>,
  sourceTool: LibrarySectionRankShadowDiagnostic['sourceTool'],
  noteId: string,
  sourceEvidenceId: string,
  readBlockIds: readonly string[],
  explicitHeadingIds: readonly string[] = [],
): LibrarySectionNavigationObservation | undefined {
  const shadowEnabled = input.sectionRankShadowMode === 'observe';
  const navigationEnabled = input.sectionRankNavigationMode === 'observe';
  if ((!shadowEnabled && !navigationEnabled)
    || input.signal.aborted
    || input.snapshotMap.indexState === 'stale'
    || !input.isSnapshotCurrent()) return;
  const activeGoalId = state.searchPlan?.activeGoalId;
  if (!activeGoalId) return;
  const activeGoal = state.searchPlan?.goals.find((goal) => goal.goalId === activeGoalId);
  if (!activeGoal) return;

  const startedAt = Date.now();
  try {
    const excludedHeadingIds = navigationEnabled
      ? recordReadHeadingIds(state, activeGoalId, noteId, [
        ...explicitHeadingIds,
        ...tools.findContentHeadingIdsByBlockIds(noteId, readBlockIds),
      ])
      : [];
    const result = tools.rankRelatedSections(noteId, activeGoal.queryTerms, excludedHeadingIds);
    const cacheIdentity = `${result.snapshotId}\u0000${result.queryTermFingerprint}\u0000${createLibrarySectionExclusionFingerprint(excludedHeadingIds)}`;
    const cacheHit = state.sectionRankShadowResults.get(cacheIdentity) === result;
    state.sectionRankShadowResults.set(cacheIdentity, result);
    const diagnostic: LibrarySectionRankShadowDiagnostic = {
      schemaVersion: 'library-section-rank-shadow-v1',
      sourceTool,
      goalId: activeGoalId,
      noteId,
      snapshotId: result.snapshotId,
      queryTermCount: activeGoal.queryTerms.length,
      evaluatedSectionCount: result.evaluatedSectionCount,
      top3Ids: result.topSections.map((section) => section.headingId),
      ambiguous: result.ambiguous,
      fallbackUsed: result.fallbackUsed,
      cacheHit,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
    if (shadowEnabled) {
      emitLibrarySectionRankShadowTrace(input, {
        stage: 'validation',
        action: 'library-section-rank-shadow',
        status: 'completed',
        callKind: 'shadow',
        input: { sourceTool, goalId: activeGoalId, noteId },
        output: diagnostic,
        elapsedMs: diagnostic.elapsedMs,
      });
    }
    if (navigationEnabled) {
      const recommendation: LibrarySectionRecommendationObservation = Object.freeze({
        goalId: activeGoalId,
        sourceEvidenceId,
        noteId,
        snapshotId: result.snapshotId,
        contentHash: result.contentHash,
        queryTermCount: activeGoal.queryTerms.length,
        evaluatedSectionCount: result.evaluatedSectionCount,
        ambiguous: result.ambiguous,
        fallbackUsed: result.fallbackUsed,
        topSections: Object.freeze([...result.topSections]),
      });
      state.navigationObservationsByGoal.set(activeGoalId, recommendation);
      recordExecutionTrace(
        state,
        'observation',
        activeGoalId,
        'library-section-rank-navigation',
        `章节BM25已评估${result.evaluatedSectionCount}章，推荐${result.topSections.length}章，queryTerms=${activeGoal.queryTerms.length}，ambiguous=${result.ambiguous}`,
        [],
      );
      emitLibrarySectionRankShadowTrace(input, {
        stage: 'validation',
        action: 'library-section-navigation-observation',
        status: 'completed',
        callKind: 'shadow',
        input: { sourceTool, goalId: activeGoalId, noteId, sourceEvidenceId },
        output: recommendation,
        elapsedMs: diagnostic.elapsedMs,
      });
      return toPublicLibrarySectionNavigation(recommendation);
    }
  } catch {
    if (shadowEnabled) {
      emitLibrarySectionRankShadowTrace(input, {
        stage: 'validation',
        action: 'library-section-rank-shadow',
        status: 'rejected',
        callKind: 'shadow',
        input: { sourceTool, goalId: activeGoalId, noteId },
        errorCode: 'LIBRARY_SECTION_RANK_SHADOW_FAILED',
        error: { name: 'LibrarySectionRankShadowError', message: '章节 Shadow 排序失败。' },
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
    }
  }
  return undefined;
}

function toPublicLibrarySectionNavigation(
  observation: LibrarySectionRecommendationObservation,
): LibrarySectionNavigationObservation {
  return {
    queryTermCount: observation.queryTermCount,
    evaluatedSectionCount: observation.evaluatedSectionCount,
    ambiguous: observation.ambiguous,
    fallbackUsed: observation.fallbackUsed,
    candidates: observation.topSections.map((candidate) => ({
      headingPath: candidate.headingPath.slice(0, 8).map((part) => part.slice(0, 240)),
      lineFrom: candidate.lineFrom,
      lineTo: candidate.lineTo,
      score: candidate.score,
      matchedTerms: candidate.matchedQueryTerms.slice(0, 12).map((term) => term.slice(0, 80)),
    })),
  };
}

function recordReadHeadingIds(
  state: LibraryAgentState,
  goalId: string,
  noteId: string,
  headingIds: readonly string[],
): string[] {
  const headingsByNote = state.readHeadingIdsByGoal.get(goalId) ?? new Map<string, Set<string>>();
  const readHeadingIds = headingsByNote.get(noteId) ?? new Set<string>();
  for (const headingId of headingIds) {
    if (headingId) readHeadingIds.add(headingId);
  }
  headingsByNote.set(noteId, readHeadingIds);
  state.readHeadingIdsByGoal.set(goalId, headingsByNote);
  return [...readHeadingIds].sort();
}

function emitLibrarySectionRankShadowTrace(
  input: LibraryPlanAgentInput,
  entry: Parameters<NonNullable<LibraryPlanAgentInput['onDetailedTrace']>>[0],
): void {
  try {
    input.onDetailedTrace?.(entry);
  } catch {
    // Detailed diagnostics are best effort and must never affect ReAct control flow.
  }
}

/** Derive a bounded read quota from the active model window, never from model arguments. */
function computeLibraryReadLimits(input: LibraryPlanAgentInput, state: LibraryAgentState, budget: CurrentNoteAgentBudget): LibraryNoteReadLimits {
  const remainingCalls = Math.max(1, state.modelCallGate.remainingModelCalls + 1);
  const windowTokens = input.contextWindowTokens ?? ASSISTANT_CONTEXT_BUDGET_TOKENS;
  const perReadTokens = Math.max(512, Math.min(
    Math.floor(windowTokens * 0.05),
    Math.floor(Math.max(512, budget.maxSingleObservationChars / 2) / remainingCalls),
  ));
  return {
    maxTokens: perReadTokens,
    maxChars: Math.min(budget.maxSingleObservationChars, perReadTokens * 4),
    maxLines: 200,
  };
}

function recordExecutionTrace(
  state: LibraryAgentState,
  kind: 'action' | 'observation' | 'correction',
  goalId: string,
  tool: string,
  summary: string,
  evidenceIds: readonly string[],
): void {
  const plan = state.searchPlan;
  if (!plan) return;
  state.traceStore.record({ planId: plan.planId, planVersion: plan.version, goalId, kind, tool, summary, evidenceIds });
}

function applyActionPatch(state: LibraryAgentState, action: Extract<LibraryAgentAction, { type: 'tool' }>, ledger: LibraryEvidenceLedger): void {
  if (!state.searchPlan) throw new Error('整库 SearchPlan 不存在。');
  if (!action.planPatch) return;
  if (NAVIGATION_TOOLS.has(action.tool) && action.planPatch.goalUpdates.some((update) => update.status === 'partial' || update.status === 'covered' || update.status === 'conflicted')) throw new Error('候选和块搜索只产生导航观察，不能直接覆盖目标。');
  const variantUpdates = action.planPatch.goalUpdates.filter((update) => (update.queryVariants?.length ?? 0) > 0);
  for (const update of variantUpdates) {
    const gate = getVariantGate(state, update.goalId);
    if (!gate.signals.size) throw new Error('当前没有搜索为空、覆盖不足或新标题/术语观察，不能追加 queryVariant。');
    for (const variant of update.queryVariants ?? []) assertVariantSource(variant, gate, state.userConfirmedTerms);
  }
  const result = applySearchPlanPatch(state.searchPlan, action.planPatch, { evidenceIds: new Set(ledger.list().map((record) => record.evidenceId)), queryVariantScope: buildVariantScope(state) });
  if (!result.ok) throw new Error(`计划补丁被拒绝：${result.message}`);
  state.searchPlan = result.plan;
  for (const update of variantUpdates) getVariantGate(state, update.goalId).signals.clear();
  emitPlanEventForState(state);
}

function startActiveGoal(state: LibraryAgentState, ledger: LibraryEvidenceLedger): void {
  if (!state.searchPlan?.activeGoalId) throw new Error('当前计划没有 activeGoalId。');
  const result = applySearchPlanPatch(state.searchPlan, { baseVersion: state.searchPlan.version, goalUpdates: [{ goalId: state.searchPlan.activeGoalId, status: 'searching' }] }, { evidenceIds: new Set(ledger.list().map((record) => record.evidenceId)) });
  if (!result.ok) throw new Error(`目标启动失败：${result.message}`);
  state.searchPlan = result.plan;
}

function commitAnswer(state: LibraryAgentState, action: Extract<LibraryAgentAction, { type: 'answer' }>, ledger: LibraryEvidenceLedger): boolean {
  if (!state.searchPlan) return false;
  const result = applySearchPlanAnswerAction(state.searchPlan, action as SearchPlanAnswerAction, { evidenceIds: new Set(ledger.list().map((record) => record.evidenceId)) });
  if (!result.ok) return false;
  if (action.completeness === 'complete' && !comparisonEvidenceSatisfied(result.plan, ledger)) return false;
  state.searchPlan = result.plan;
  return true;
}

function comparisonEvidenceSatisfied(plan: SearchPlan, ledger: LibraryEvidenceLedger): boolean {
  for (const goal of plan.goals.filter((candidate) => candidate.evidenceKind === 'comparison' && candidate.status === 'covered')) {
    const noteIds = new Set<string>();
    for (const binding of goal.evidenceBindings) {
      const subject = goal.requirements.find((requirement) => requirement.requirementId === binding.requirementId)?.subject;
      if (!subject || binding.evidenceIds.length === 0) return false;
      for (const evidenceId of binding.evidenceIds) {
        const evidence = ledger.get(evidenceId);
        if (!evidence) return false;
        noteIds.add(evidence.noteId);
      }
    }
    if (noteIds.size < 2) return false;
  }
  return true;
}

function ensureActionGoal(plan: SearchPlan, goalId: string): void {
  if (!plan.activeGoalId || plan.activeGoalId !== goalId) throw new Error('工具动作 goalId 必须等于补丁应用后的 activeGoalId。');
  const goal = plan.goals.find((candidate) => candidate.goalId === goalId);
  if (!goal || !isSearchGoalExecutable(goal.status)) throw new Error('当前 activeGoal 不可执行。');
}

function requireCandidate(state: LibraryAgentState, noteId: string): void {
  if (!state.discoveredNoteIds.has(noteId)) throw new Error('只能读取本轮已经召回的候选 noteId。');
}

function recordVariantSignals(state: LibraryAgentState, goalId: string, observation: Awaited<ReturnType<typeof executeLibraryTool>>, input: LibraryPlanAgentInput): void {
  const gate = getVariantGate(state, goalId);
  if (observation.emptySearch) gate.signals.add('empty-search');
  if (state.searchPlan?.goals.find((goal) => goal.goalId === goalId)?.status === 'partial') gate.signals.add('coverage-insufficient');
  if (observation.variantTerms) {
    for (const term of collectTerms(observation.variantTerms.terms)) {
      if (observation.variantTerms.source === 'note-map') gate.noteMapTerms.add(term);
      else gate.searchObservationTerms.add(term);
    }
    gate.signals.add('new-note-term');
  }
  void input;
}

function getVariantGate(state: LibraryAgentState, goalId: string): VariantGate {
  const existing = state.variantGates.get(goalId);
  if (existing) return existing;
  const gate: VariantGate = { signals: new Set(), noteMapTerms: new Set(), searchObservationTerms: new Set() };
  state.variantGates.set(goalId, gate);
  return gate;
}

function assertVariantSource(variant: QueryVariant, gate: VariantGate, userConfirmedTerms: ReadonlySet<string>): void {
  const term = normalizeTerm(variant.term);
  const allowed = variant.source === 'model-synonym'
    || variant.source === 'note-map' && gate.noteMapTerms.has(term)
    || variant.source === 'search-observation' && gate.searchObservationTerms.has(term)
    || variant.source === 'user-confirmed' && userConfirmedTerms.has(term);
  if (!allowed) throw new Error(`queryVariant ${term} 的 source=${variant.source} 无法由当前作用域证明。`);
}

function buildVariantScope(state: LibraryAgentState): { noteMapTerms: string[]; searchObservationTerms: string[]; userConfirmedTerms: string[] } {
  const noteMapTerms = new Set<string>();
  const searchObservationTerms = new Set<string>();
  for (const gate of state.variantGates.values()) {
    for (const term of gate.noteMapTerms) noteMapTerms.add(term);
    for (const term of gate.searchObservationTerms) searchObservationTerms.add(term);
  }
  return { noteMapTerms: [...noteMapTerms], searchObservationTerms: [...searchObservationTerms], userConfirmedTerms: [...state.userConfirmedTerms] };
}

function collectUserTerms(question: string, conversation: AssistantConversationMessage[]): Set<string> {
  return new Set(collectTerms([question, ...conversation.filter((message) => message.role === 'user').map((message) => message.content)]));
}

function collectTerms(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => [normalizeTerm(value), ...tokenizeCurrentNoteText(value).map(normalizeTerm)]).filter((term) => term.length >= 2))];
}

function normalizeTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '');
}

function recordProgress(state: LibraryAgentState, observation: { evidenceAdded: boolean; emptySearch: boolean; searchSet?: string }, budget: CurrentNoteAgentBudget): void {
  if (!observation.emptySearch && observation.searchSet !== undefined) {
    if (state.searchResultSets.has(observation.searchSet)) state.noProgressCount += 1;
    state.searchResultSets.add(observation.searchSet);
  } else if (observation.evidenceAdded) state.noProgressCount = 0;
  if (state.noProgressCount >= budget.maxNoProgressRounds) state.stopReason = 'no-progress';
}

function prepareLibraryModelCall(
  input: LibraryPlanAgentInput,
  state: LibraryAgentState,
  budget: CurrentNoteAgentBudget,
  callKind: PromptCallKind,
  prompt: string,
  retryOfTicketId?: string,
): { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined {
  if (input.modelCallCoordinator) {
    const prepared = input.modelCallCoordinator.prepare({ callKind, prompt, ...(retryOfTicketId ? { retryOfTicketId } : {}) });
    if (!prepared.ready) {
      state.stopReason = prepared.reason === 'context-budget'
        ? 'context-budget'
        : prepared.reason === 'timeout' ? 'timeout' : 'max-model-calls';
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
    contextWindowTokens: input.contextWindowTokens,
    callKind,
    calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({ providerKind: input.providerKind, model: input.model, callKind }),
  });
  if (!plan.fits) {
    state.modelCallGate.cancelUnsent(ticket);
    state.stopReason = 'context-budget';
    return undefined;
  }
  state.modelCallGate.markSent(ticket);
  state.modelCalls = state.modelCallGate.modelCalls;
  state.lastPromptPlan = plan;
  if (state.lastPromptStats) state.lastPromptStats = { ...state.lastPromptStats, predictedPromptTokens: plan.predictedPromptTokens, maxPromptTokens: plan.maxPromptTokens, maxOutputTokens: plan.maxOutputTokens, safetyReserveTokens: plan.safetyReserveTokens };
  return { ticket, plan };
}

async function runLibraryDecision(input: LibraryPlanAgentInput, state: LibraryAgentState, budget: CurrentNoteAgentBudget, prompt: string, prefix: string, question: string, conversation: AssistantConversationMessage[], ledger: LibraryEvidenceLedger): Promise<LibraryAgentAction | undefined> {
  const projectionLevels = chooseLibraryProjectionLevels(input, 'decide', prompt);
  let prepared: { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined;
  let sentPrompt = prompt;
  let lastPrepareFailure: CurrentNoteAgentStats['stopReason'] | undefined;
  for (const level of projectionLevels) {
    const candidatePrompt = level === 0 ? prompt : composeDecisionPrompt(prefix, question, conversation, state, ledger, level);
    const previousStopReason = state.stopReason;
    state.stopReason = undefined;
    const candidatePrepared = prepareLibraryModelCall(input, state, budget, 'decide', candidatePrompt);
    if (candidatePrepared) {
      prepared = candidatePrepared;
      sentPrompt = candidatePrompt;
      break;
    }
    lastPrepareFailure = state.stopReason;
    state.stopReason = previousStopReason;
  }
  if (!prepared) {
    state.stopReason = lastPrepareFailure === 'max-model-calls' || lastPrepareFailure === 'timeout' ? lastPrepareFailure : 'context-budget';
    return undefined;
  }
  try {
    return await input.driver.decide({ prompt: sentPrompt, signal: input.signal, maxOutputTokens: prepared.plan.maxOutputTokens, jsonSchema: LIBRARY_DECIDE_STRUCTURED_OUTPUT, onUsage: observeLibraryModelUsage(input, state, 'decide', sentPrompt) });
  } catch (error) {
    if (!isAiContextOverflow(error)) return undefined;
    const retryPrompt = composeDecisionPrompt(prefix, question, conversation, state, ledger, 4);
    const retry = prepareLibraryModelCall(input, state, budget, 'decide', retryPrompt, prepared.ticket.ticketId);
    if (!retry) {
      state.stopReason = 'context-budget';
      return undefined;
    }
    try {
      return await input.driver.decide({ prompt: retryPrompt, signal: input.signal, maxOutputTokens: retry.plan.maxOutputTokens, jsonSchema: LIBRARY_DECIDE_STRUCTURED_OUTPUT, onUsage: observeLibraryModelUsage(input, state, 'decide', retryPrompt) });
    } catch (retryError) {
      if (isAiContextOverflow(retryError)) state.stopReason = 'context-budget';
      return undefined;
    }
  }
}

async function synthesizeOrFallback(input: LibraryPlanAgentInput, prefix: string, state: LibraryAgentState, ledger: LibraryEvidenceLedger, budget: CurrentNoteAgentBudget, startedAt: number): Promise<Extract<LibraryAgentAction, { type: 'answer' }>> {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (state.modelCalls >= budget.maxModelCalls || hasWallTimeExpired(budget, startedAt)) {
    return { type: 'answer', answer: '本轮整库检索预算已用尽，当前仅能返回已读取的部分证据。', citations: ledger.list().map((record) => record.evidenceId), completeness: ledger.list().length ? 'partial' : 'not-found' };
  }
  const basePrompt = composeAnswerPrompt(prefix, input.question, state.searchPlan, ledger, state, 0);
  const projectionLevels = chooseLibraryProjectionLevels(input, 'synthesize', basePrompt);
  const prompts = projectionLevels.map((level) => ({ level, prompt: level === 0 ? basePrompt : composeAnswerPrompt(prefix, input.question, state.searchPlan, ledger, state, level) }));
  let prepared: { ticket: ModelCallTicket; plan: PromptBudgetPlan } | undefined;
  let prompt = basePrompt;
  let lastPrepareFailure: CurrentNoteAgentStats['stopReason'] | undefined;
  for (const candidate of prompts) {
    const previousStopReason = state.stopReason;
    state.stopReason = undefined;
    const candidatePrepared = prepareLibraryModelCall(input, state, budget, 'synthesize', candidate.prompt);
    if (candidatePrepared) {
      prepared = candidatePrepared;
      prompt = candidate.prompt;
      break;
    }
    lastPrepareFailure = state.stopReason;
    state.stopReason = previousStopReason;
  }
  if (!prepared) {
    state.stopReason = lastPrepareFailure === 'max-model-calls' || lastPrepareFailure === 'timeout' ? lastPrepareFailure : 'context-budget';
    return { type: 'answer', answer: '本轮整库检索预算已用尽，当前仅能返回已读取的部分证据。', citations: ledger.list().map((record) => record.evidenceId), completeness: ledger.list().length ? 'partial' : 'not-found' };
  }
  try {
    return await input.driver.synthesize({ prompt, signal: input.signal, maxOutputTokens: prepared.plan.maxOutputTokens, jsonSchema: LIBRARY_SYNTHESIZE_STRUCTURED_OUTPUT, onUsage: observeLibraryModelUsage(input, state, 'synthesize', prompt) });
  } catch (error) {
    if (isAiContextOverflow(error)) {
      const retryPrompt = prompts.at(-1)?.prompt ?? prompt;
      const retry = prepareLibraryModelCall(input, state, budget, 'synthesize', retryPrompt, prepared.ticket.ticketId);
      if (retry) {
        try {
          return await input.driver.synthesize({ prompt: retryPrompt, signal: input.signal, maxOutputTokens: retry.plan.maxOutputTokens, jsonSchema: LIBRARY_SYNTHESIZE_STRUCTURED_OUTPUT, onUsage: observeLibraryModelUsage(input, state, 'synthesize', retryPrompt) });
        } catch (retryError) {
          if (isAiContextOverflow(retryError)) state.stopReason = 'context-budget';
        }
      } else {
        state.stopReason = 'context-budget';
      }
    }
    state.invalidActionCount += 1;
    return { type: 'answer', answer: '整库原文证据不足，当前结果只能作为部分结果。', citations: ledger.list().map((record) => record.evidenceId), completeness: ledger.list().length ? 'partial' : 'not-found' };
  }
}

function finalize(input: LibraryPlanAgentInput, prefix: string, ledger: LibraryEvidenceLedger, state: LibraryAgentState, answer: string, completeness: 'complete' | 'partial' | 'not-found'): LibraryPlanAgentResult {
  const evidence = ledger.toAssistantCitations(ledger.list().map((record) => record.evidenceId));
  const finalPrompt = composeAnswerPrompt(prefix, input.question, state.searchPlan, ledger, state, state.highestProjectionLevel);
  const promptStats = state.lastPromptStats;
  return {
    answer,
    evidence,
    sourceNotes: [...state.candidates.values()].slice(0, 8),
    completeness,
    toolStats: { calls: state.toolCalls, searchedBlocks: state.searchedBlocks, readCharacters: state.readCharacters, elapsedMs: state.elapsedMs },
    agentStats: { decisionRounds: state.decisionRounds, modelCalls: state.modelCalls, stopReason: state.stopReason ?? 'answered' },
    prefixFingerprint: createHash('sha256').update(`${prefix}\u0000${finalPrompt.slice(0, 400)}`, 'utf8').digest('hex').slice(0, 24),
    contextUsage: {
      ...estimateAssistantContextUsage(finalPrompt, input.contextWindowTokens),
      ...(promptStats ? { promptStats } : {}),
    },
    ...(state.searchPlan ? { searchPlan: state.searchPlan } : {}),
  };
}

function composeDecisionPrompt(prefix: string, question: string, conversation: AssistantConversationMessage[], state: LibraryAgentState, ledger: LibraryEvidenceLedger, projectionLevel: 0 | 1 | 3 | 4 = 0): string {
  const projection = new PlanAwarePromptProjector(state.traceStore).build({
    callKind: 'decide',
    stablePrefix: prefix,
    question,
    conversation,
    plan: state.searchPlan,
    baseVersion: state.searchPlan?.version,
    evidence: ledger.list(),
    navigationObservations: state.searchPlan?.activeGoalId
      ? [state.navigationObservationsByGoal.get(state.searchPlan.activeGoalId)].filter((observation): observation is LibrarySectionRecommendationObservation => Boolean(observation))
      : [],
    traceStore: state.traceStore,
    outputSchema: LIBRARY_DECIDE_JSON_SCHEMA,
    projectionLevel,
    rulesText: '只输出一个 JSON。工具动作必须包含 goalId 且等于 activeGoalId；每轮只能执行一个工具。工具 arguments 只能使用对应工具允许的结构化 ID，不得提交路径。read_library_adjacent_section 只能提交 evidenceId 和 previous/next，noteId、headingId、行号和父路径必须由主进程推导。候选和块搜索只用于导航；只有 read_library_note_range、read_library_note_section、expand_library_evidence 或 read_library_adjacent_section 读取原文后，才能绑定证据或改变覆盖状态。expand_library_evidence 是以证据为锚点扩展前后 Markdown 上下文，为保持结构完整可能返回完整重叠 block。queryVariants 必须有当前观察支持。answer 可以携带最后一个 planPatch。',
  });
  state.lastPromptStats = projection.promptStats;
  state.highestProjectionLevel = Math.max(state.highestProjectionLevel, projection.compactionLevel) as 0 | 1 | 3 | 4;
  return projection.prompt;
}

function composeAnswerPrompt(prefix: string, question: string, plan: SearchPlan | undefined, ledger: LibraryEvidenceLedger, state?: LibraryAgentState, projectionLevel: 0 | 1 | 3 | 4 = 0): string {
  const projection = new PlanAwarePromptProjector(state?.traceStore).build({
    callKind: 'synthesize',
    stablePrefix: prefix,
    question,
    plan,
    evidence: ledger.list(),
    traceStore: state?.traceStore,
    baseVersion: plan?.version,
    projectionLevel,
    outputSchema: LIBRARY_SYNTHESIZE_JSON_SCHEMA,
    rulesText: '只能引用有效原文 evidenceId；候选标题、snippet、matchTrace 和 queryVariant 不是事实证据。最终合成只依据 coverage 与最小充分原文证据，不携带完整搜索轨迹。',
  });
  if (state) {
    state.lastPromptStats = projection.promptStats;
    state.highestProjectionLevel = Math.max(state.highestProjectionLevel, projection.compactionLevel) as 0 | 1 | 3 | 4;
  }
  return projection.prompt;
}

function chooseLibraryProjectionLevels(input: LibraryPlanAgentInput, callKind: Extract<PromptCallKind, 'decide' | 'synthesize'>, prompt: string): Array<0 | 1 | 3 | 4> {
  const plan = new PromptBudgetScheduler().plan({
    prompt,
    contextWindowTokens: input.contextWindowTokens,
    callKind,
    calibrationMultiplier: (input.tokenCalibrationStore ?? sharedTokenCalibrationStore).getMultiplier({ providerKind: input.providerKind, model: input.model, callKind }),
  });
  const ratio = plan.maxPromptTokens > 0 ? plan.predictedPromptTokens / plan.maxPromptTokens : 1;
  // observe computes this candidate but keeps the legacy prompt unchanged;
  // enforce is the only mode allowed to send a compacted projection.
  if (input.adaptiveContextMode !== 'enforce') return [0];
  if (ratio >= 0.94) return [4];
  if (ratio >= 0.90) return [3, 4];
  return [0, 3, 4];
}

function observeLibraryModelUsage(input: LibraryPlanAgentInput, state: LibraryAgentState, callKind: PromptCallKind, prompt: string): (usage: AssistantTokenUsage) => void {
  return (usage) => {
    const calibration = input.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    calibration.observeUsage({ providerKind: input.providerKind, model: input.model, callKind }, estimateTokenCount(prompt), usage);
    if (state.lastPromptStats && state.lastPromptStats.callKind === callKind && usage.inputTokens !== undefined) {
      state.lastPromptStats = { ...state.lastPromptStats, predictedPromptTokens: usage.inputTokens };
    }
  };
}

function beforeDecision(input: LibraryPlanAgentInput, state: LibraryAgentState, budget: CurrentNoteAgentBudget, startedAt: number): CurrentNoteAgentStats['stopReason'] | undefined {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) return 'snapshot-stale';
  if (hasWallTimeExpired(budget, startedAt)) return 'timeout';
  if (state.searchPlan?.status === 'active' && state.searchPlan.activeGoalId === null) return 'no-progress';
  if (state.decisionRounds >= budget.maxDecisionRounds) return 'max-decision-rounds';
  if (state.modelCalls >= budget.maxModelCalls - 1) return 'max-model-calls';
  return undefined;
}

function beforeTool(input: LibraryPlanAgentInput, state: LibraryAgentState, budget: CurrentNoteAgentBudget, startedAt: number): CurrentNoteAgentStats['stopReason'] | undefined {
  if (input.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
  if (!input.isSnapshotCurrent()) return 'snapshot-stale';
  if (hasWallTimeExpired(budget, startedAt)) return 'timeout';
  if (state.toolCalls >= budget.maxToolCalls) return 'max-tool-calls';
  return undefined;
}

function hasWallTimeExpired(budget: CurrentNoteAgentBudget, startedAt: number): boolean {
  return budget.maxWallTimeMs !== undefined && Date.now() - startedAt >= budget.maxWallTimeMs;
}

function registerInvalid(state: LibraryAgentState, budget: CurrentNoteAgentBudget, _error: unknown): void {
  state.invalidActionCount += 1;
  if (state.invalidActionCount >= budget.maxInvalidActions) state.stopReason = 'invalid-action';
}

function hasUnseenEvidencePatch(patch: Extract<LibraryAgentAction, { type: 'tool' }>['planPatch'], ledger: LibraryEvidenceLedger): boolean {
  if (!patch) return false;
  const known = new Set(ledger.list().map((record) => record.evidenceId));
  return patch.goalUpdates.some((update) => [
    ...(update.evidenceBindings?.flatMap((binding) => binding.evidenceIds) ?? []),
    ...(update.conflictBindings?.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]) ?? []),
  ].some((evidenceId) => !known.has(evidenceId)));
}

function actionSignature(plan: SearchPlan | undefined, action: Extract<LibraryAgentAction, { type: 'tool' }>): string {
  return createHash('sha256').update(`${plan?.version ?? 0}\u0000${action.goalId}\u0000${action.tool}\u0000${stableJson(action.arguments)}\u0000${stableJson(action.planPatch)}`, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('工具参数包含不允许的字段。');
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label}必须是整数。`);
  return value as number;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  const result = integer(value, label);
  if (result < min || result > max) throw new Error(`${label}必须在 ${min} 到 ${max} 之间。`);
  return result;
}

function createStablePrefix(provider: AiProviderKind, model: string, capsule: ReturnType<typeof createLibraryPlanCapsule>): string {
  return `[整库受控检索]\nprovider=${provider} model=${model}\nlibraryId=${capsule.libraryId} indexState=${capsule.indexState}\n仅原文 Evidence Ledger 可支持事实结论；路径、隐藏推理和 Provider 请求不得进入动作。`;
}

function emitTool(input: LibraryPlanAgentInput, event: CurrentNotePublicToolEvent): void {
  input.onToolEvent?.(event);
}

/** Keeps the debug rail useful without disclosing planner terms, note IDs or paths. */
function summarizeLibraryToolInput(action: ValidatedLibraryAction): string {
  switch (action.tool) {
    case 'search_note_library':
      return `当前目标：受控关键词召回；最多 ${action.limit} 篇候选笔记`;
    case 'get_library_note_map':
      return `候选笔记：${action.detail === 'outline' ? '目录结构' : action.detail === 'stats' ? '统计信息' : '关键词'}`;
    case 'search_library_note_blocks':
      return `候选笔记：搜索片段；最多 ${action.limit} 个片段`;
    case 'read_library_note_range':
      return `候选笔记原文：L${action.lineFrom}–L${action.lineTo}`;
    case 'read_library_note_section':
      return action.cursor === undefined ? '候选笔记章节：从章节起始处读取' : `候选笔记章节：从续读位置 ${action.cursor} 读取`;
    case 'expand_library_evidence':
      return `现有证据：向前 ${action.beforeLines} 行、向后 ${action.afterLines} 行`;
    case 'read_library_adjacent_section':
      return action.direction === 'previous' ? '现有证据：读取上一个同级章节' : '现有证据：读取下一个同级章节';
  }
}

function emitPlanEvent(input: LibraryPlanAgentInput, state: LibraryAgentState, ledger: LibraryEvidenceLedger, phase: CurrentNotePublicPlanEvent['phase']): void {
  if (!state.searchPlan) return;
  const evidenceIds = new Set(ledger.list().map((record) => record.evidenceId));
  input.onPlanEvent?.({
    phase,
    status: state.searchPlan.status,
    goals: state.searchPlan.goals.map((goal) => ({ label: goal.question.replace(/\s+/gu, ' ').trim().slice(0, 48), status: goal.status, evidenceCount: new Set([...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds), ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds])].filter((evidenceId) => ledger.get(evidenceId))).size })),
    searchPlan: projectPublicSearchPlan(state.searchPlan, evidenceIds),
    ...(state.lastQueryTerms?.length ? { finalQueryTerms: state.lastQueryTerms } : {}),
  });
}

function emitPlanEventForState(_state: LibraryAgentState): void {
  // The caller emits the public event after each completed tool. This helper
  // exists to keep patch application free of UI concerns.
}

export { createLibraryPlanCapsule, createLibraryPlanPrompt } from './libraryPlanDriver';
export { createLibraryNoteTools, searchLibraryNoteCandidates } from './libraryNoteTools';
export { createLibraryNoteSnapshotMap, replaceLibraryNoteSnapshotMap } from './libraryNoteSnapshot';
