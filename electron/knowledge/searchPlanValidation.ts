import { randomUUID } from 'node:crypto';
import { normalizeTechnicalTerm } from './lexicalMatchPolicy';
import { parseCurrentNoteSearchScopePlannerInput } from './currentNoteSearchScope';
import {
  DEFAULT_SEARCH_PLAN_BUDGET,
  SEARCH_QUERY_TERM_BATCH_SIZE,
  SEARCH_QUERY_VARIANTS_PER_PATCH,
  searchEvidenceKinds,
  searchGoalStatuses,
  searchPlanCompleteness,
  searchPlanStatuses,
  searchQueryTermSources,
  type QueryVariant,
  type SearchConflictBinding,
  type SearchEvidenceBinding,
  type SearchPlanEvidenceIds,
  type SearchEvidenceRequirement,
  type SearchGoal,
  type SearchGoalStatus,
  type SearchPlan,
  type SearchPlanAnswerAction,
  type SearchPlanDraft,
  type SearchPlanPatch,
  type SearchPlanPatchGoalUpdate,
  type SearchPlanPatchOptions,
  type SearchPlanStatus,
  type SearchQueryVariantScope,
  type SearchQueryTerm,
  type SearchPlanValidationOptions,
} from './searchPlanTypes';

const SAFE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u;
const MAX_TEXT_LENGTH = 8_000;
const MAX_QUERY_TERM_LENGTH = 80;
const MAX_MISSING_EVIDENCE_LENGTH = 2_000;
const PLANNER_QUERY_TERM_DISCOURSE = new Set([
  '请', '请你', '请问', '帮我', '基于', '根据', '当前笔记', '这篇笔记', '本篇笔记',
  '分析', '解释', '说明', '介绍', '告诉我', '告诉', '是什么', '是啥', '什么意思',
  '如何', '为什么', '有哪些', '什么', '问题', '内容', '笔记',
]);
const PLANNER_QUERY_TERM_RESERVED_KEYS = new Set([
  'scope', 'goals', 'goalid', 'question', 'evidencekind', 'requirements', 'queryterms',
  'requirementid', 'label', 'subject', 'minevidence', 'mode', 'coveragepolicy',
  'targettopic', 'targetaspects',
]);

const EXECUTABLE_GOAL_STATUSES = new Set<SearchGoalStatus>(['pending', 'searching', 'partial']);
const REOPENABLE_GOAL_STATUSES = new Set<SearchGoalStatus>(['partial', 'conflicted', 'not-found']);
const TERMINAL_GOAL_STATUSES = new Set<SearchGoalStatus>(['partial', 'covered', 'conflicted', 'not-found']);
const CONTROLLER_TERMINAL_PLAN_STATUSES = new Set<SearchPlanStatus>([
  'completed',
  'partial',
  'not-found',
  'failed',
  'cancelled',
  'stale',
  'interrupted',
]);

export class SearchPlanValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SearchPlanValidationError';
  }
}

export type SearchPlanValidationResult =
  | { valid: true; plan: SearchPlan }
  | { valid: false; code: string; message: string };

export type SearchPlanPatchResult =
  | { ok: true; plan: SearchPlan; changedGoalIds: string[]; revisionApplied: boolean }
  | { ok: false; code: string; message: string };

export type SearchPlanAnswerResult =
  | { ok: true; plan: SearchPlan }
  | { ok: false; code: string; message: string };

export interface CreateSearchPlanOptions {
  planId?: string;
  now?: string;
  goalIdFactory?: (index: number) => string;
}

export interface ControllerStatusOptions {
  now?: string;
  relaxRequirementMinEvidence?: boolean;
  allowConflictedComplete?: boolean;
}

/** Creates a controller-owned plan from an already separated local draft. */
export function createSearchPlan(input: SearchPlanDraft, options: CreateSearchPlanOptions = {}): SearchPlan {
  assertPlainObject(input, '计划草稿');
  assertText(input.originalQuestion, '原始问题', MAX_TEXT_LENGTH);
  if (!Array.isArray(input.goals)) fail('invalid-goals', '计划目标必须是数组。');
  if (input.goals.length < 1 || input.goals.length > DEFAULT_SEARCH_PLAN_BUDGET.maxGoals) {
    fail('goal-count', '计划必须包含 1 到 4 个目标。');
  }

  const planId = options.planId ?? generateSearchPlanId();
  assertSafeId(planId, 'planId');
  const goalIdFactory = options.goalIdFactory ?? (() => generateSearchGoalId());
  const goals = input.goals.map((goal, index) => createInitialGoal(goal, goal.goalId ?? goalIdFactory(index)));
  const now = normalizeTimestamp(options.now ?? new Date().toISOString(), 'createdAt');
  const plan: SearchPlan = {
    planId,
    version: 1,
    originalQuestion: input.originalQuestion.trim(),
    goals,
    activeGoalId: goals[0].goalId,
    status: 'active',
    revisionCount: 0,
    goalUpdateCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return assertValidSearchPlan(plan);
}

/** Parses the intentionally small model-facing planner output and owns all plan metadata locally. */
export function createSearchPlanFromPlanner(
  value: unknown,
  originalQuestion: string,
  options: CreateSearchPlanOptions = {},
): SearchPlan {
  assertPlainObject(value, 'Planner 输出');
  assertOnlyKeys(value, ['scope', 'goals'], 'Planner 输出');
  const plannerScope = value.scope === undefined
    ? undefined
    : parseCurrentNoteSearchScopePlannerInput(value.scope, originalQuestion);
  if (!Array.isArray(value.goals)) fail('invalid-goals', 'Planner 输出的 goals 必须是数组。');
  const goals = value.goals.map((rawGoal, goalIndex) => {
    assertPlainObject(rawGoal, `Planner 目标 ${goalIndex + 1}`);
    assertOnlyKeys(rawGoal, ['goalId', 'question', 'evidenceKind', 'requirements', 'queryTerms'], `Planner 目标 ${goalIndex + 1}`);
    const requirements = readPlannerRequirements(rawGoal.requirements, goalIndex);
    if (!Array.isArray(rawGoal.queryTerms) || !rawGoal.queryTerms.every((term) => typeof term === 'string')) {
      fail('invalid-query-terms', `Planner 目标 ${goalIndex + 1} 的 queryTerms 必须是字符串数组。`);
    }
    if (rawGoal.queryTerms.length > SEARCH_QUERY_TERM_BATCH_SIZE) {
      fail('planner-query-term-count', `Planner 目标 ${goalIndex + 1} 的 queryTerms 最多包含 ${SEARCH_QUERY_TERM_BATCH_SIZE} 个查询词。`);
    }
    const semanticQueryTerms = collectPlannerSemanticQueryTerms(rawGoal.queryTerms);
    const queryTerms = semanticQueryTerms.length > 0
      ? semanticQueryTerms
      : recoverPlannerQueryTerms(requirements, plannerScope?.targetTopic);
    if (queryTerms.length === 0) {
      fail('missing-semantic-query-terms', `Planner 目标 ${goalIndex + 1} 没有可用于检索的语义锚点。`);
    }
    return {
      ...(rawGoal.goalId === undefined || rawGoal.goalId === null
        ? {}
        : { goalId: readSafeId(rawGoal.goalId, `目标 ${goalIndex + 1} 的 goalId`) }),
      question: readText(rawGoal.question, `目标 ${goalIndex + 1} 的 question`, MAX_TEXT_LENGTH),
      evidenceKind: readEnum(rawGoal.evidenceKind, searchEvidenceKinds, `目标 ${goalIndex + 1} 的 evidenceKind`),
      requirements,
      queryTerms,
    };
  });
  return createSearchPlan({ originalQuestion, goals }, options);
}

/**
 * Returns the Planner-owned search vocabulary in stable goal/term order.
 * Search execution may deduplicate across goals, but must not derive or rewrite
 * these terms from the user's question after the plan has been accepted.
 */
export function collectSearchPlanQueryTerms(plan: SearchPlan): string[] {
  return [...new Set(plan.goals.flatMap((goal) => goal.queryTerms.map((queryTerm) => queryTerm.term)))];
}

/** QueryTerms name note concepts; they must not be question wording. */
function normalizePlannerSemanticQueryTerm(value: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeQueryTerm(value);
  } catch {
    return undefined;
  }
  if (!normalized || PLANNER_QUERY_TERM_DISCOURSE.has(normalized)) return undefined;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return undefined;
  const reservedKey = normalized.toLocaleLowerCase().replace(/[_\-\s]+/gu, '');
  if (PLANNER_QUERY_TERM_RESERVED_KEYS.has(reservedKey)) return undefined;
  return /^[\u3400-\u9fff]$/u.test(normalized) ? undefined : normalized;
}

function collectPlannerSemanticQueryTerms(values: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePlannerSemanticQueryTerm(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= SEARCH_QUERY_TERM_BATCH_SIZE) break;
  }
  return terms;
}

function recoverPlannerQueryTerms(
  requirements: readonly SearchEvidenceRequirement[],
  targetTopic: string | undefined,
): string[] {
  return collectPlannerSemanticQueryTerms([
    ...requirements.flatMap((requirement) => requirement.subject ? [requirement.subject] : []),
    ...requirements.map((requirement) => requirement.label),
    ...(targetTopic ? [targetTopic] : []),
  ]);
}

export function generateSearchPlanId(): string {
  return `plan-${randomUUID()}`;
}

export function generateSearchGoalId(): string {
  return `goal-${randomUUID()}`;
}

export function isSearchGoalExecutable(status: SearchGoalStatus): boolean {
  return EXECUTABLE_GOAL_STATUSES.has(status);
}

export function isSearchGoalReopenable(status: SearchGoalStatus): boolean {
  return REOPENABLE_GOAL_STATUSES.has(status);
}

export function canTransitionSearchGoalStatus(
  from: SearchGoalStatus,
  to: SearchGoalStatus,
  options: { hasReplanSignal?: boolean; remainingRevisions?: number } = {},
): boolean {
  if (from === to) return true;
  if (from === 'covered') return false;
  if (from === 'pending') return to === 'searching';
  if (from === 'searching') return TERMINAL_GOAL_STATUSES.has(to);
  if (REOPENABLE_GOAL_STATUSES.has(from)) {
    if (to === 'searching') return Boolean(options.hasReplanSignal) && (options.remainingRevisions ?? 0) > 0;
    return TERMINAL_GOAL_STATUSES.has(to);
  }
  return false;
}

export function validateSearchPlan(value: unknown, options: SearchPlanValidationOptions = {}): SearchPlanValidationResult {
  try {
    const plan = assertSearchPlan(value, options);
    return { valid: true, plan };
  } catch (error) {
    const normalized = normalizeError(error);
    return { valid: false, code: normalized.code, message: normalized.message };
  }
}

export function assertValidSearchPlan(value: unknown, options: SearchPlanValidationOptions = {}): SearchPlan {
  return assertSearchPlan(value, options);
}

/** Applies the complete nine-step patch algorithm on a cloned plan, never partially mutating the input. */
export function applySearchPlanPatch(
  plan: SearchPlan,
  patch: SearchPlanPatch,
  options: SearchPlanPatchOptions = {},
): SearchPlanPatchResult {
  try {
    const current = assertSearchPlan(plan, options);
    assertPatchShape(patch);
    if (current.status !== 'active') fail('plan-not-active', '只有 active 计划可以应用模型补丁。');
    if (patch.baseVersion !== current.version) fail('stale-base-version', 'SearchPlanPatch 的 baseVersion 已过期。');

    const currentGoals = new Map(current.goals.map((goal) => [goal.goalId, goal]));
    const updateIds = new Set<string>();
    for (const update of patch.goalUpdates) {
      assertSafeId(update.goalId, 'goalUpdate.goalId');
      if (updateIds.has(update.goalId)) fail('duplicate-goal-update', `goalId ${update.goalId} 在补丁中重复。`);
      updateIds.add(update.goalId);
      if (!currentGoals.has(update.goalId)) fail('unknown-goal-id', `补丁引用了不存在的 goalId：${update.goalId}。`);
      assertGoalUpdateHasField(update);
    }

    const currentOrder = current.goals.map((goal) => goal.goalId);
    const nextOrder = patch.goalOrder === undefined ? currentOrder : validateGoalOrder(patch.goalOrder, currentOrder);
    const orderChanged = !sameStringArray(currentOrder, nextOrder);
    const nextGoals = new Map(current.goals.map((goal) => [goal.goalId, cloneGoal(goal)]));
    const changedGoalIds: string[] = [];
    let queryVariantCount = 0;

    for (const update of patch.goalUpdates) {
      const currentGoal = currentGoals.get(update.goalId)!;
      if (currentGoal.status === 'covered') fail('covered-goal-immutable', `covered 目标 ${update.goalId} 只能由本地 stale 检测失效。`);
      const nextGoal = cloneGoal(currentGoal);
      const hasStatus = hasOwn(update, 'status');
      const hasVariants = hasOwn(update, 'queryVariants');
      const hasEvidence = hasOwn(update, 'evidenceBindings');
      const hasConflict = hasOwn(update, 'conflictBindings');
      const hasMissing = hasOwn(update, 'missingEvidence');
      const variants = hasVariants ? validateQueryVariants(update.queryVariants, currentGoal, options) : [];
      queryVariantCount += variants.length;
      const hasReplanSignal = variants.length > 0 || orderChanged;
      const nextStatus = hasStatus ? validateGoalStatus(update.status) : currentGoal.status;
      if (!canTransitionSearchGoalStatus(currentGoal.status, nextStatus, {
        hasReplanSignal,
        remainingRevisions: DEFAULT_SEARCH_PLAN_BUDGET.maxPlanRevisions - current.revisionCount,
      })) {
        fail('invalid-goal-transition', `目标 ${update.goalId} 不能从 ${currentGoal.status} 转换为 ${nextStatus}。`);
      }
      if (variants.length > 0 && isSearchGoalReopenable(currentGoal.status) && nextStatus !== 'searching') {
        fail('query-variant-requires-searching', `目标 ${update.goalId} 追加查询词时必须进入 searching。`);
      }
      if (variants.length > 0) {
        nextGoal.queryTerms.push(...variants.map((variant) => ({ term: normalizeQueryTerm(variant.term), source: variant.source })));
      }
      if (hasStatus) nextGoal.status = nextStatus;
      if (hasEvidence) {
        nextGoal.evidenceBindings = validateEvidenceBindings(update.evidenceBindings, nextGoal, options, 'evidenceBindings', true);
      }
      if (hasConflict) {
        nextGoal.conflictBindings = validateConflictBindings(update.conflictBindings, nextGoal, options, true);
      }
      if (hasMissing) {
        if (update.missingEvidence === null) delete nextGoal.missingEvidence;
        else nextGoal.missingEvidence = readText(update.missingEvidence, 'missingEvidence', MAX_MISSING_EVIDENCE_LENGTH);
      }
      validateGoal(nextGoal, options);
      if (!sameGoal(currentGoal, nextGoal)) changedGoalIds.push(update.goalId);
      nextGoals.set(update.goalId, nextGoal);
    }

    if (patch.goalUpdates.some((update) => !changedGoalIds.includes(update.goalId))) {
      fail('no-op-goal-update', '补丁包含没有实际变化的 goal update。');
    }
    const revisionApplied = orderChanged || queryVariantCount > 0;
    if (revisionApplied && current.revisionCount >= DEFAULT_SEARCH_PLAN_BUDGET.maxPlanRevisions) {
      fail('revision-limit', 'SearchPlan 的重规划次数已耗尽。');
    }
    if (current.goalUpdateCount + patch.goalUpdates.length > DEFAULT_SEARCH_PLAN_BUDGET.maxGoalUpdates) {
      fail('goal-update-limit', 'SearchPlan 的目标更新次数已耗尽。');
    }

    const orderedGoals = nextOrder.map((goalId) => nextGoals.get(goalId)!);
    const nextActiveGoalId = resolveActiveGoalId(current, patch, orderedGoals, options);
    const nextPlan: SearchPlan = {
      ...current,
      goals: orderedGoals,
      activeGoalId: nextActiveGoalId,
      version: current.version + 1,
      revisionCount: current.revisionCount + (revisionApplied ? 1 : 0),
      goalUpdateCount: current.goalUpdateCount + patch.goalUpdates.length,
      updatedAt: normalizeTimestamp(options.now ?? new Date().toISOString(), 'updatedAt'),
    };
    const validated = assertSearchPlan(nextPlan, {
      ...options,
      allowActiveGoalClear: options.isAnswerFinalizing,
    });
    if (!revisionApplied && !changedGoalIds.length && nextActiveGoalId === current.activeGoalId) {
      fail('no-op-patch', '补丁没有任何实际变化。');
    }
    return { ok: true, plan: validated, changedGoalIds, revisionApplied };
  } catch (error) {
    const normalized = normalizeError(error);
    return { ok: false, code: normalized.code, message: normalized.message };
  }
}

/**
 * Structured Outputs must materialize the nullable planPatch field. Some
 * compatible providers still choose an object that is equivalent to omission.
 * Ignore only a whole-patch no-op at the model boundary; malformed, stale and
 * per-goal no-op updates remain rejected by applySearchPlanPatch.
 */
export function applyModelSearchPlanPatch(
  plan: SearchPlan,
  patch: SearchPlanPatch,
  options: SearchPlanPatchOptions = {},
): SearchPlanPatchResult {
  const result = applySearchPlanPatch(plan, patch, options);
  if (result.ok || result.code !== 'no-op-patch') return result;
  return {
    ok: true,
    plan: assertSearchPlan(plan, options),
    changedGoalIds: [],
    revisionApplied: false,
  };
}

export function assertApplySearchPlanPatch(
  plan: SearchPlan,
  patch: SearchPlanPatch,
  options: SearchPlanPatchOptions = {},
): SearchPlan {
  const result = applySearchPlanPatch(plan, patch, options);
  if (!result.ok) throw new SearchPlanValidationError(result.code, result.message);
  return result.plan;
}

/** Atomically applies an optional final patch and validates answer completeness without letting the model set plan status. */
export function applySearchPlanAnswerAction(
  plan: SearchPlan,
  action: SearchPlanAnswerAction,
  options: SearchPlanPatchOptions = {},
): SearchPlanAnswerResult {
  try {
    assertPlainObject(action, 'answer 动作');
    assertOnlyKeys(action, ['type', 'answer', 'citations', 'completeness', 'planPatch'], 'answer 动作');
    if (action.type !== 'answer') fail('invalid-answer-action', '只接受 type=answer 的动作。');
    assertText(action.answer, 'answer', MAX_TEXT_LENGTH);
    const completeness = readEnum(action.completeness, searchPlanCompleteness, 'completeness');
    let nextPlan = assertSearchPlan(plan, options);
    if (action.planPatch !== undefined) {
      const patched = applyModelSearchPlanPatch(nextPlan, action.planPatch, { ...options, isAnswerFinalizing: true });
      if (!patched.ok) throw new SearchPlanValidationError(patched.code, patched.message);
      nextPlan = patched.plan;
    }
    validateCitationIds(action.citations, options.evidenceIds);
    if (completeness === 'complete' && !nextPlan.goals.every((goal) => goal.status === 'covered'
      || (options.allowConflictedComplete && goal.status === 'conflicted'))) {
      fail('incomplete-answer', 'complete answer 要求所有目标 covered，或已完成双边冲突解释。');
    }
    return { ok: true, plan: nextPlan };
  } catch (error) {
    const normalized = normalizeError(error);
    return { ok: false, code: normalized.code, message: normalized.message };
  }
}

/** Controller-only lifecycle transition; SearchPlanPatch intentionally has no plan status field. */
export function setSearchPlanControllerStatus(
  plan: SearchPlan,
  status: SearchPlanStatus,
  options: ControllerStatusOptions = {},
): SearchPlan {
  const current = assertSearchPlan(plan, {
    relaxRequirementMinEvidence: options.relaxRequirementMinEvidence,
    allowConflictedComplete: options.allowConflictedComplete,
  });
  if (!CONTROLLER_TERMINAL_PLAN_STATUSES.has(status)) fail('invalid-controller-status', '控制器只能设置计划终态。');
  if (status === 'completed' && !current.goals.every((goal) => goal.status === 'covered'
    || (options.allowConflictedComplete && goal.status === 'conflicted'))) {
    fail('incomplete-plan', '只有所有目标 covered，或已完成双边冲突解释，才能将计划设置为 completed。');
  }
  if (status === 'stale') {
    if (current.status === 'stale') fail('invalid-controller-transition', '计划已经是 stale。');
  } else if (current.status !== 'active') {
    fail('plan-not-active', '只有 active 计划可以进入控制器终态。');
  }
  const settledGoalStatus: SearchGoalStatus | undefined = status === 'not-found' ? 'not-found' : status === 'partial' ? 'partial' : undefined;
  const goals = settledGoalStatus
    ? current.goals.map((goal) => isSearchGoalExecutable(goal.status)
      ? { ...goal, status: settledGoalStatus }
      : goal)
    : current.goals;
  return {
    ...current,
    goals,
    status,
    activeGoalId: null,
    version: current.version + 1,
    updatedAt: normalizeTimestamp(options.now ?? new Date().toISOString(), 'updatedAt'),
  };
}

export function markSearchPlanStale(plan: SearchPlan, now?: string): SearchPlan {
  return setSearchPlanControllerStatus(plan, 'stale', { now });
}

function assertSearchPlan(value: unknown, options: SearchPlanValidationOptions = {}): SearchPlan {
  assertPlainObject(value, 'SearchPlan');
  assertOnlyKeys(value, ['planId', 'version', 'originalQuestion', 'goals', 'activeGoalId', 'status', 'revisionCount', 'goalUpdateCount', 'createdAt', 'updatedAt'], 'SearchPlan');
  const plan = value as unknown as SearchPlan;
  assertSafeId(plan.planId, 'planId');
  assertIntegerAtLeast(plan.version, 1, 'version');
  assertText(plan.originalQuestion, 'originalQuestion', MAX_TEXT_LENGTH);
  if (!Array.isArray(plan.goals) || plan.goals.length < 1 || plan.goals.length > DEFAULT_SEARCH_PLAN_BUDGET.maxGoals) {
    fail('goal-count', 'SearchPlan 必须包含 1 到 4 个目标。');
  }
  assertEnum(plan.status, searchPlanStatuses, '计划 status');
  assertIntegerRange(plan.revisionCount, 0, DEFAULT_SEARCH_PLAN_BUDGET.maxPlanRevisions, 'revisionCount');
  assertIntegerRange(plan.goalUpdateCount, 0, DEFAULT_SEARCH_PLAN_BUDGET.maxGoalUpdates, 'goalUpdateCount');
  normalizeTimestamp(plan.createdAt, 'createdAt');
  normalizeTimestamp(plan.updatedAt, 'updatedAt');
  if (plan.activeGoalId !== null) assertSafeId(plan.activeGoalId, 'activeGoalId');

  const goalIds = new Set<string>();
  const requirementIds = new Set<string>();
  for (const goal of plan.goals) {
    assertGoal(goal, options);
    if (goalIds.has(goal.goalId)) fail('duplicate-goal-id', `goalId ${goal.goalId} 重复。`);
    goalIds.add(goal.goalId);
    for (const requirement of goal.requirements) {
      if (requirementIds.has(requirement.requirementId)) fail('duplicate-requirement-id', `requirementId ${requirement.requirementId} 重复。`);
      requirementIds.add(requirement.requirementId);
    }
  }
  if (plan.activeGoalId !== null) {
    const activeGoal = plan.goals.find((goal) => goal.goalId === plan.activeGoalId);
    if (!activeGoal) fail('unknown-active-goal', `activeGoalId ${plan.activeGoalId} 不存在。`);
    if (plan.status === 'active' && !isSearchGoalExecutable(activeGoal.status)) {
      fail('inactive-active-goal', 'active 计划的 activeGoalId 必须指向可执行目标。');
    }
  }
  if (plan.status === 'active' && plan.activeGoalId === null && plan.goals.some((goal) => isSearchGoalExecutable(goal.status)) && !options.allowActiveGoalClear) {
    fail('missing-active-goal', 'active 计划仍有可执行目标时不能清空 activeGoalId。');
  }
  if (plan.status === 'completed' && (plan.activeGoalId !== null || !plan.goals.every((goal) => goal.status === 'covered'
    || (options.allowConflictedComplete && goal.status === 'conflicted')))) {
    fail('invalid-completed-plan', 'completed 计划必须所有目标 covered 且 activeGoalId 为 null。');
  }
  return clonePlan(plan);
}

function assertGoal(value: unknown, options: SearchPlanValidationOptions): asserts value is SearchGoal {
  assertPlainObject(value, 'SearchGoal');
  assertOnlyKeys(value, ['goalId', 'question', 'evidenceKind', 'requirements', 'queryTerms', 'status', 'evidenceBindings', 'conflictBindings', 'missingEvidence'], 'SearchGoal');
  const goal = value as unknown as SearchGoal;
  assertSafeId(goal.goalId, 'goalId');
  assertText(goal.question, 'goal.question', MAX_TEXT_LENGTH);
  assertEnum(goal.evidenceKind, searchEvidenceKinds, 'goal.evidenceKind');
  assertEnum(goal.status, searchGoalStatuses, 'goal.status');
  if (!Array.isArray(goal.requirements) || goal.requirements.length < 1 || goal.requirements.length > DEFAULT_SEARCH_PLAN_BUDGET.maxRequirementsPerGoal) {
    fail('requirement-count', '每个目标必须包含 1 到 4 个 requirement。');
  }
  if (!Array.isArray(goal.queryTerms) || goal.queryTerms.length < 1) {
    fail('query-term-count', '每个目标必须至少包含 1 个查询词。');
  }
  const queryKeys = new Set<string>();
  for (const queryTerm of goal.queryTerms) {
    assertQueryTerm(queryTerm);
    const key = normalizeQueryTerm(queryTerm.term);
    if (queryKeys.has(key)) fail('duplicate-query-term', `查询词 ${queryTerm.term} 重复。`);
    queryKeys.add(key);
  }
  for (const requirement of goal.requirements) assertRequirement(requirement);
  validateEvidenceBindings(goal.evidenceBindings, goal, options, 'evidenceBindings');
  validateConflictBindings(goal.conflictBindings, goal, options);
  if (goal.missingEvidence !== undefined) assertText(goal.missingEvidence, 'missingEvidence', MAX_MISSING_EVIDENCE_LENGTH);
  if (goal.status === 'covered') validateCoveredGoal(goal, options);
  if (goal.status === 'conflicted' && goal.conflictBindings.length === 0) fail('missing-conflict-binding', 'conflicted 目标必须包含冲突绑定。');
}

function createInitialGoal(input: SearchPlanDraft['goals'][number], goalId: string): SearchGoal {
  assertSafeId(goalId, 'goalId');
  const queryTerms = input.queryTerms.map((value) => {
    if (typeof value === 'string') return { term: normalizeQueryTerm(value), source: 'planner' as const };
    assertPlainObject(value, 'queryTerm');
    assertOnlyKeys(value, ['term', 'source'], 'queryTerm');
    if (value.source !== 'planner') fail('invalid-planner-source', '初始计划查询词只能使用 planner source。');
    return { term: normalizeQueryTerm(readText(value.term, 'queryTerm.term', MAX_QUERY_TERM_LENGTH)), source: 'planner' as const };
  });
  const goal: SearchGoal = {
    goalId,
    question: input.question.trim(),
    evidenceKind: input.evidenceKind,
    requirements: input.requirements.map((requirement) => ({ ...requirement })),
    queryTerms,
    status: 'pending',
    evidenceBindings: [],
    conflictBindings: [],
  };
  validateGoal(goal, {});
  return goal;
}

function validateGoal(goal: SearchGoal, options: SearchPlanValidationOptions): void {
  assertGoal(goal, options);
}

function readPlannerRequirements(value: unknown, goalIndex: number): SearchEvidenceRequirement[] {
  if (!Array.isArray(value)) fail('invalid-requirements', `Planner 目标 ${goalIndex + 1} 的 requirements 必须是数组。`);
  return value.map((rawRequirement, requirementIndex) => {
    assertPlainObject(rawRequirement, `Planner requirement ${goalIndex + 1}.${requirementIndex + 1}`);
    assertOnlyKeys(rawRequirement, ['requirementId', 'label', 'subject', 'minEvidence'], 'Planner requirement');
    return {
      requirementId: readSafeId(rawRequirement.requirementId, 'requirementId'),
      label: readText(rawRequirement.label, 'requirement.label', MAX_TEXT_LENGTH),
      ...(rawRequirement.subject === undefined || rawRequirement.subject === null
        ? {}
        : { subject: readText(rawRequirement.subject, 'requirement.subject', MAX_TEXT_LENGTH) }),
      minEvidence: readIntegerRange(rawRequirement.minEvidence, 1, 3, 'requirement.minEvidence'),
    };
  });
}

function validateGoalOrder(value: unknown, currentOrder: string[]): string[] {
  if (!Array.isArray(value) || value.length !== currentOrder.length || !value.every((goalId) => typeof goalId === 'string')) {
    fail('invalid-goal-order', 'goalOrder 必须是现有 goalId 的完整排列。');
  }
  const order = value as string[];
  if (new Set(order).size !== order.length || order.some((goalId) => !currentOrder.includes(goalId))) {
    fail('invalid-goal-order', 'goalOrder 必须是现有 goalId 的完整排列。');
  }
  return [...order];
}

function resolveActiveGoalId(
  current: SearchPlan,
  patch: SearchPlanPatch,
  goals: SearchGoal[],
  options: SearchPlanPatchOptions,
): string | null {
  const requested = hasOwn(patch, 'activeGoalId') ? patch.activeGoalId : current.activeGoalId;
  if (requested !== null) {
    assertSafeId(requested, 'activeGoalId');
    const goal = goals.find((candidate) => candidate.goalId === requested);
    if (!goal) fail('unknown-active-goal', `activeGoalId ${requested} 不存在。`);
    if (!isSearchGoalExecutable(goal.status)) fail('inactive-active-goal', 'activeGoalId 必须指向可执行或本次重开的目标。');
    return requested;
  }
  const hasExecutableGoal = goals.some((goal) => isSearchGoalExecutable(goal.status));
  if (hasExecutableGoal && !options.isAnswerFinalizing) fail('active-goal-clear-forbidden', '仍有可执行目标时不能清空 activeGoalId。');
  return null;
}

function validateQueryVariants(value: unknown, currentGoal: SearchGoal, options: SearchPlanPatchOptions): QueryVariant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SEARCH_QUERY_VARIANTS_PER_PATCH) {
    fail('query-variant-count', `每次补丁最多追加 ${SEARCH_QUERY_VARIANTS_PER_PATCH} 个 queryVariant。`);
  }
  const seen = new Set<string>();
  const existing = new Set(currentGoal.queryTerms.map((queryTerm) => normalizeQueryTerm(queryTerm.term)));
  return value.map((rawVariant) => {
    assertPlainObject(rawVariant, 'queryVariant');
    assertOnlyKeys(rawVariant, ['term', 'source'], 'queryVariant');
    const source = readEnum(rawVariant.source, ['note-map', 'search-observation', 'model-synonym', 'user-confirmed'] as const, 'queryVariant.source');
    const term = normalizeQueryTerm(readText(rawVariant.term, 'queryVariant.term', MAX_QUERY_TERM_LENGTH));
    if (seen.has(term)) fail('duplicate-query-variant', `queryVariant ${term} 在补丁中重复。`);
    if (existing.has(term)) fail('duplicate-query-variant', `queryVariant ${term} 已存在于目标 queryTerms。`);
    assertQueryVariantSourceScope(term, source, options.queryVariantScope);
    seen.add(term);
    return { term, source };
  });
}

function assertQueryVariantSourceScope(
  term: string,
  source: QueryVariant['source'],
  scope: SearchQueryVariantScope | undefined,
): void {
  if (!scope || source === 'model-synonym') return;
  const terms = source === 'note-map'
    ? scope.noteMapTerms
    : source === 'search-observation'
      ? scope.searchObservationTerms
      : scope.userConfirmedTerms;
  if (!terms?.some((candidate) => normalizeQueryTerm(candidate) === term)) {
    fail('query-variant-source-scope', `queryVariant ${term} 的 source=${source} 无法由当前作用域证明。`);
  }
}

function validateEvidenceBindings(
  value: unknown,
  goal: SearchGoal,
  options: SearchPlanValidationOptions,
  label: string,
  requireScope = false,
): SearchEvidenceBinding[] {
  if (!Array.isArray(value)) fail('invalid-evidence-bindings', `${label} 必须是数组。`);
  const requirements = new Set(goal.requirements.map((requirement) => requirement.requirementId));
  const boundRequirements = new Set<string>();
  return value.map((rawBinding) => {
    assertPlainObject(rawBinding, label);
    assertOnlyKeys(rawBinding, ['requirementId', 'evidenceIds'], label);
    const binding = rawBinding as unknown as SearchEvidenceBinding;
    assertSafeId(binding.requirementId, `${label}.requirementId`);
    if (!requirements.has(binding.requirementId)) fail('unknown-requirement-id', `${label} 引用了不存在的 requirementId。`);
    if (boundRequirements.has(binding.requirementId)) fail('duplicate-binding-requirement', `${label} 的 requirementId 重复。`);
    boundRequirements.add(binding.requirementId);
    const evidenceIds = validateEvidenceIdList(binding.evidenceIds, label, options, DEFAULT_SEARCH_PLAN_BUDGET.maxEvidencePerRequirementBinding, requireScope);
    return { requirementId: binding.requirementId, evidenceIds };
  });
}

function validateConflictBindings(value: unknown, goal: SearchGoal, options: SearchPlanValidationOptions, requireScope = false): SearchConflictBinding[] {
  if (!Array.isArray(value)) fail('invalid-conflict-bindings', 'conflictBindings 必须是数组。');
  const requirements = new Set(goal.requirements.map((requirement) => requirement.requirementId));
  const boundRequirements = new Set<string>();
  return value.map((rawBinding) => {
    assertPlainObject(rawBinding, 'conflictBindings');
    assertOnlyKeys(rawBinding, ['requirementId', 'supportsEvidenceIds', 'contradictsEvidenceIds'], 'conflictBinding');
    const binding = rawBinding as unknown as SearchConflictBinding;
    assertSafeId(binding.requirementId, 'conflictBinding.requirementId');
    if (!requirements.has(binding.requirementId)) fail('unknown-requirement-id', 'conflictBinding 引用了不存在的 requirementId。');
    if (boundRequirements.has(binding.requirementId)) fail('duplicate-conflict-requirement', 'conflictBinding 的 requirementId 重复。');
    boundRequirements.add(binding.requirementId);
    const supports = validateEvidenceIdList(binding.supportsEvidenceIds, 'supportsEvidenceIds', options, DEFAULT_SEARCH_PLAN_BUDGET.maxEvidencePerConflictSide, requireScope);
    const contradicts = validateEvidenceIdList(binding.contradictsEvidenceIds, 'contradictsEvidenceIds', options, DEFAULT_SEARCH_PLAN_BUDGET.maxEvidencePerConflictSide, requireScope);
    if (supports.some((evidenceId) => contradicts.includes(evidenceId))) fail('overlapping-conflict-evidence', '冲突支持和反对证据不得重叠。');
    if (supports.length + contradicts.length > DEFAULT_SEARCH_PLAN_BUDGET.maxEvidencePerConflictSide * 2) fail('conflict-evidence-limit', '冲突绑定两侧合计最多 8 条证据。');
    return { requirementId: binding.requirementId, supportsEvidenceIds: supports, contradictsEvidenceIds: contradicts };
  });
}

function validateEvidenceIdList(value: unknown, label: string, options: SearchPlanValidationOptions, max: number, requireScope: boolean): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((evidenceId) => typeof evidenceId === 'string')) {
    fail('invalid-evidence-count', `${label} 必须包含 1 到 ${max} 条证据。`);
  }
  const evidenceIds = value as string[];
  if (new Set(evidenceIds).size !== evidenceIds.length) fail('duplicate-evidence-id', `${label} 中 evidenceId 不得重复。`);
  for (const evidenceId of evidenceIds) {
    assertSafeId(evidenceId, 'evidenceId');
    if (options.evidenceIds !== undefined && !hasEvidenceId(options.evidenceIds, evidenceId)) {
      fail('unknown-evidence-id', `evidenceId ${evidenceId} 不属于当前 Evidence Ledger。`);
    }
  }
  if (requireScope && options.evidenceIds === undefined && evidenceIds.length > 0) {
    fail('evidence-scope-required', '校验证据绑定时必须提供当前 Evidence Ledger 作用域。');
  }
  return [...evidenceIds];
}

function validateCoveredGoal(goal: SearchGoal, options: SearchPlanValidationOptions): void {
  if (goal.missingEvidence !== undefined || goal.conflictBindings.length > 0) fail('invalid-covered-goal', 'covered 目标不能保留 missingEvidence 或 conflictBindings。');
  const bindings = new Map(goal.evidenceBindings.map((binding) => [binding.requirementId, binding.evidenceIds.length]));
  for (const requirement of goal.requirements) {
    const requiredEvidence = options.relaxRequirementMinEvidence ? 1 : requirement.minEvidence;
    if ((bindings.get(requirement.requirementId) ?? 0) < requiredEvidence) {
      fail('insufficient-evidence', `requirement ${requirement.requirementId} 的 distinct evidenceId 未达到当前完成门槛。`);
    }
  }
}

function assertPatchShape(value: unknown): asserts value is SearchPlanPatch {
  assertPlainObject(value, 'SearchPlanPatch');
  assertOnlyKeys(value, ['baseVersion', 'activeGoalId', 'goalOrder', 'goalUpdates'], 'SearchPlanPatch');
  assertIntegerAtLeast(value.baseVersion, 1, 'baseVersion');
  if (!Array.isArray(value.goalUpdates)) fail('invalid-goal-updates', 'goalUpdates 必须是数组。');
  if (value.goalUpdates.length > DEFAULT_SEARCH_PLAN_BUDGET.maxGoals) fail('goal-update-count', '单个补丁不能更新超过 4 个目标。');
}

function assertGoalUpdateHasField(update: SearchPlanPatchGoalUpdate): void {
  const fields = ['status', 'queryVariants', 'evidenceBindings', 'conflictBindings', 'missingEvidence'] as const;
  if (!fields.some((field) => hasOwn(update, field))) fail('empty-goal-update', 'goalUpdate 不能没有任何更新字段。');
}

function validateGoalStatus(value: unknown): SearchGoalStatus {
  return readEnum(value, searchGoalStatuses, 'goal.status');
}

function assertQueryTerm(value: unknown): asserts value is SearchQueryTerm {
  assertPlainObject(value, 'queryTerm');
  assertOnlyKeys(value, ['term', 'source'], 'queryTerm');
  normalizeQueryTerm(readText(value.term, 'queryTerm.term', MAX_QUERY_TERM_LENGTH));
  assertEnum(value.source, searchQueryTermSources, 'queryTerm.source');
}

function assertRequirement(value: unknown): asserts value is SearchEvidenceRequirement {
  assertPlainObject(value, 'requirement');
  assertOnlyKeys(value, ['requirementId', 'label', 'subject', 'minEvidence'], 'requirement');
  assertSafeId(value.requirementId, 'requirementId');
  assertText(value.label, 'requirement.label', MAX_TEXT_LENGTH);
  if (value.subject !== undefined) assertText(value.subject, 'requirement.subject', MAX_TEXT_LENGTH);
  assertIntegerRange(value.minEvidence, 1, 3, 'requirement.minEvidence');
}

function normalizeQueryTerm(value: string): string {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > MAX_QUERY_TERM_LENGTH || Array.from(normalized).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  })) fail('invalid-query-term', '查询词必须是非空且不超过 80 个字符的文本。');
  return normalized;
}

function validateCitationIds(value: unknown, evidenceIds?: SearchPlanEvidenceIds): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((evidenceId) => typeof evidenceId === 'string')) fail('invalid-citations', 'citations 必须是 evidenceId 字符串数组。');
  const citations = value as string[];
  if (new Set(citations).size !== citations.length) fail('duplicate-citation', 'citations 不得重复。');
  for (const evidenceId of citations) {
    assertSafeId(evidenceId, 'citation evidenceId');
    if (evidenceIds !== undefined && !hasEvidenceId(evidenceIds, evidenceId)) fail('unknown-evidence-id', `citation evidenceId ${evidenceId} 不属于当前 Evidence Ledger。`);
  }
}

function clonePlan(plan: SearchPlan): SearchPlan {
  return {
    ...plan,
    goals: plan.goals.map(cloneGoal),
  };
}

function cloneGoal(goal: SearchGoal): SearchGoal {
  return {
    ...goal,
    requirements: goal.requirements.map((requirement) => ({ ...requirement })),
    queryTerms: goal.queryTerms.map((queryTerm) => ({ ...queryTerm })),
    evidenceBindings: goal.evidenceBindings.map((binding) => ({ ...binding, evidenceIds: [...binding.evidenceIds] })),
    conflictBindings: goal.conflictBindings.map((binding) => ({ ...binding, supportsEvidenceIds: [...binding.supportsEvidenceIds], contradictsEvidenceIds: [...binding.contradictsEvidenceIds] })),
  };
}

function sameGoal(first: SearchGoal, second: SearchGoal): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function sameStringArray(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function hasEvidenceId(evidenceIds: SearchPlanEvidenceIds, evidenceId: string): boolean {
  if (evidenceIds instanceof Set) return evidenceIds.has(evidenceId);
  return (evidenceIds as readonly string[]).includes(evidenceId);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-object', `${label} 必须是对象。`);
}

function assertOnlyKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) fail('unexpected-field', `${label} 包含不允许的字段：${key}。`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) fail('invalid-id', `${label} 格式无效。`);
}

function readSafeId(value: unknown, label: string): string {
  assertSafeId(value, label);
  return value;
}

function assertText(value: unknown, label: string, maxLength: number): asserts value is string {
  readText(value, label, maxLength);
}

function readText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) fail('invalid-text', `${label} 必须是非空且长度不超过 ${maxLength} 的文本。`);
  return value;
}

function assertIntegerAtLeast(value: unknown, minimum: number, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum) fail('invalid-integer', `${label} 必须是不小于 ${minimum} 的整数。`);
}

function assertIntegerRange(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) fail('invalid-range', `${label} 必须在 ${minimum} 到 ${maximum} 之间。`);
}

function readIntegerRange(value: unknown, minimum: number, maximum: number, label: string): number {
  assertIntegerRange(value, minimum, maximum, label);
  return value;
}

function assertEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): asserts value is T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('invalid-enum', `${label} 值无效。`);
}

function readEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  assertEnum(value, allowed, label);
  return value;
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) fail('invalid-timestamp', `${label} 必须是有效时间戳。`);
  return value;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof SearchPlanValidationError) return error;
  return { code: 'invalid-search-plan', message: error instanceof Error ? error.message : String(error) };
}

function fail(code: string, message: string): never {
  throw new SearchPlanValidationError(code, message);
}
