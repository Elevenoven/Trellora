import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-search-plan-contract');
const outFile = path.join(outDir, 'searchPlanValidation.cjs');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanValidation.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  applySearchPlanAnswerAction,
  applyModelSearchPlanPatch,
  applySearchPlanPatch,
  assertApplySearchPlanPatch,
  assertValidSearchPlan,
  createSearchPlan,
  createSearchPlanFromPlanner,
  collectSearchPlanQueryTerms,
  markSearchPlanStale,
  setSearchPlanControllerStatus,
  validateSearchPlan,
} = await import(pathToFileURL(outFile).href);

const EVIDENCE_IDS = new Set(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10']);
const NOW = '2026-08-22T08:00:00.000Z';

function makeGoal(id, {
  requirementCount = 1,
  minEvidence = 1,
  subjects,
  queryTerms = ['alpha'],
  evidenceKind = 'fact',
} = {}) {
  return {
    goalId: id,
    question: `核实 ${id}`,
    evidenceKind,
    requirements: Array.from({ length: requirementCount }, (_, index) => ({
      requirementId: `${id}-r${index + 1}`,
      label: `${id} requirement ${index + 1}`,
      ...(subjects?.[index] ? { subject: subjects[index] } : {}),
      minEvidence,
    })),
    queryTerms,
  };
}

function makePlan({ goals = [makeGoal('goal-1')], planId = 'plan-1' } = {}) {
  return createSearchPlan({ originalQuestion: '验证 SearchPlan 契约', goals }, {
    planId,
    now: NOW,
    goalIdFactory: (index) => `goal-generated-${index + 1}`,
  });
}

function apply(plan, patch, options = {}) {
  const result = applySearchPlanPatch(plan, patch, { evidenceIds: EVIDENCE_IDS, now: NOW, ...options });
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return result.plan;
}

function rejectPatch(plan, patch, code) {
  const before = JSON.stringify(plan);
  const result = applySearchPlanPatch(plan, patch, { evidenceIds: EVIDENCE_IDS, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, code, result.ok ? 'patch unexpectedly succeeded' : result.message);
  assert.equal(JSON.stringify(plan), before, '拒绝补丁不得部分修改原计划');
}

function rejectThrow(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

const aggregatedTermsPlan = makePlan({ goals: [
  makeGoal('goal-aggregate-1', { queryTerms: ['NER', '命名实体识别'] }),
  makeGoal('goal-aggregate-2', { queryTerms: ['ner', '内置规则识别', 'spaCy'] }),
] });
assert.deepEqual(
  collectSearchPlanQueryTerms(aggregatedTermsPlan),
  ['ner', '命名实体识别', '内置规则识别', 'spacy'],
  '跨目标 QueryTerm 必须按 Planner 顺序汇总并去重，不再从问题文本二次派生。',
);

function startSearching(plan, goalId = plan.goals[0].goalId) {
  return apply(plan, {
    baseVersion: plan.version,
    goalUpdates: [{ goalId, status: 'searching' }],
  });
}

// Initial creation owns plan metadata and marks model query terms as planner terms.
const plannerPlan = createSearchPlanFromPlanner({
  goals: [{
    goalId: 'goal-model',
    question: '核实 SQLite',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-model', label: 'SQLite 原文', minEvidence: 1 }],
    queryTerms: ['SQLite', '持久化'],
  }],
}, '用户原始问题', { planId: 'plan-local', now: NOW });
assert.equal(plannerPlan.planId, 'plan-local');
assert.equal(plannerPlan.version, 1);
assert.equal(plannerPlan.status, 'active');
assert.equal(plannerPlan.revisionCount, 0);
assert.equal(plannerPlan.goalUpdateCount, 0);
assert.equal(plannerPlan.activeGoalId, 'goal-model');
assert.deepEqual(plannerPlan.goals[0].queryTerms.map(({ term, source }) => ({ term, source })), [
  { term: 'sqlite', source: 'planner' },
  { term: '持久化', source: 'planner' },
]);
const semanticPlannerPlan = createSearchPlanFromPlanner({
  goals: [{
    goalId: 'goal-semantic',
    question: '核实 NER',
    evidenceKind: 'definition',
    requirements: [{ requirementId: 'req-semantic', label: 'NER 定义', minEvidence: 1 }],
    queryTerms: [']', 'goal_id', 'question', 'evidenceKind', 'requirements', 'queryTerms', 'label', 'NER'],
  }],
}, 'NER 是什么？', { planId: 'plan-semantic', now: NOW });
assert.deepEqual(semanticPlannerPlan.goals[0].queryTerms.map((term) => term.term), ['ner'], 'Planner Schema 字段和纯标点不得进入 QueryTerm。');
const recoveredPlannerPlan = createSearchPlanFromPlanner({
  scope: { mode: 'focused', coveragePolicy: 'sufficient', targetTopic: 'GraphRAG 入库', targetAspects: [] },
  goals: [{
    goalId: 'goal-junk',
    question: '无效计划',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-junk', label: '实体归一化处理', subject: 'CanonicalEntityGroup', minEvidence: 1 }],
    queryTerms: [']', 'goal_id', 'queryTerms'],
  }],
}, '无效计划', { planId: 'plan-junk', now: NOW });
assert.deepEqual(
  recoveredPlannerPlan.goals[0].queryTerms.map((term) => term.term),
  ['canonicalentitygroup', '实体归一化处理', 'graphrag 入库'],
  'Planner QueryTerm 全部无效时，应按 subject、requirement.label、targetTopic 恢复语义锚点。',
);
rejectThrow(() => createSearchPlanFromPlanner({
  goals: [{
    goalId: 'goal-too-many-terms',
    question: '初始词数量必须有界',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-too-many-terms', label: '初始词数量', minEvidence: 1 }],
    queryTerms: Array.from({ length: 9 }, (_, index) => `term-${index + 1}`),
  }],
}, '初始词数量必须有界', { planId: 'plan-too-many-terms', now: NOW }), 'planner-query-term-count');
rejectThrow(() => createSearchPlanFromPlanner({ sessionId: 'fake', goals: [] }, '问题', { planId: 'plan-local', now: NOW }), 'unexpected-field');
rejectThrow(() => createSearchPlanFromPlanner({ path: 'C:/secret', goals: [] }, '问题', { planId: 'plan-local', now: NOW }), 'unexpected-field');
rejectThrow(() => createSearchPlanFromPlanner({ goals: [{ ...plannerPlan.goals[0], budget: 99 }] }, '问题', { planId: 'plan-local', now: NOW }), 'unexpected-field');

// Structural lower bounds and duplicate IDs/terms. QueryTerm accumulation has no business count limit.
rejectThrow(() => makePlan({ goals: [] }), 'goal-count');
rejectThrow(() => makePlan({ goals: Array.from({ length: 5 }, (_, index) => makeGoal(`g${index + 1}`)) }), 'goal-count');
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { requirementCount: 0 })] }), 'requirement-count');
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { requirementCount: 5 })] }), 'requirement-count');
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { queryTerms: [] })] }), 'query-term-count');
const unboundedTerms = Array.from({ length: 40 }, (_, index) => `term-${index + 1}`);
assert.equal(makePlan({ goals: [makeGoal('g1', { queryTerms: unboundedTerms })] }).goals[0].queryTerms.length, 40);
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { minEvidence: 0 })] }), 'invalid-range');
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { minEvidence: 4 })] }), 'invalid-range');
rejectThrow(() => makePlan({ goals: [makeGoal('g1'), makeGoal('g1')] }), 'duplicate-goal-id');
rejectThrow(() => makePlan({ goals: [makeGoal('g1'), makeGoal('g2', { queryTerms: ['alpha'] })].map((goal) => ({
  ...goal,
  requirements: [{ ...goal.requirements[0], requirementId: 'same-requirement' }],
})) }), 'duplicate-requirement-id');
rejectThrow(() => makePlan({ goals: [makeGoal('g1', { queryTerms: ['Alpha', 'alpha'] })] }), 'duplicate-query-term');
const combinedSubjectComparisonPlan = createSearchPlanFromPlanner({
  goals: [{
    goalId: 'goal-combined-comparison',
    question: '比较 NER 与 LLM 抽取。',
    evidenceKind: 'comparison',
    requirements: [{ requirementId: 'req-combined-comparison', label: 'NER 与 LLM 抽取的区分', subject: 'NER vs LLM抽取', minEvidence: 1 }],
    queryTerms: ['NER', ']'],
  }],
}, '比较 NER 与 LLM 抽取。', { planId: 'plan-combined-comparison', now: NOW });
assert.equal(combinedSubjectComparisonPlan.goals[0].requirements.length, 1, 'comparison 允许使用一个合并 subject 的 requirement。');
assert.equal(combinedSubjectComparisonPlan.goals[0].requirements[0].subject, 'NER vs LLM抽取');
assert.deepEqual(combinedSubjectComparisonPlan.goals[0].queryTerms.map((term) => term.term), ['ner'], '合并 subject 的 comparison 应保留语义 QueryTerm 并过滤纯标点。');
const comparisonPlan = makePlan({ goals: [makeGoal('g1', { evidenceKind: 'comparison', subjects: ['项目A', '项目B'], requirementCount: 2 })] });
assert.equal(comparisonPlan.goals[0].requirements[0].subject, '项目A');
assert.equal(comparisonPlan.goals[0].requirements[1].subject, '项目B');

// Normal target path, exact update/revision counters and activeGoal semantics.
let plan = makePlan({ goals: [makeGoal('goal-1'), makeGoal('goal-2')] });
rejectPatch(plan, { baseVersion: 1, goalUpdates: [{ goalId: 'goal-1', status: 'partial' }] }, 'invalid-goal-transition');
plan = apply(plan, { baseVersion: 1, goalUpdates: [{ goalId: 'goal-1', status: 'searching' }] });
assert.equal(plan.version, 2);
assert.equal(plan.goalUpdateCount, 1);
assert.equal(plan.revisionCount, 0);
assert.equal(plan.activeGoalId, 'goal-1', 'activeGoalId 省略时保持不变');
plan = apply(plan, {
  baseVersion: 2,
  goalUpdates: [{
    goalId: 'goal-1',
    status: 'partial',
    evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }],
    missingEvidence: '还缺少适用条件',
  }],
});
assert.equal(plan.goals[0].status, 'partial');
assert.equal(plan.goals[0].missingEvidence, '还缺少适用条件');
assert.deepEqual(plan.goals[0].evidenceBindings[0].evidenceIds, ['e1']);
assert.equal(plan.goalUpdateCount, 2);
rejectPatch(plan, { baseVersion: 1, goalUpdates: [{ goalId: 'goal-1', status: 'searching' }] }, 'stale-base-version');
rejectPatch(plan, { baseVersion: plan.version, goalUpdates: [] }, 'no-op-patch');
const ignoredModelNoOp = applyModelSearchPlanPatch(plan, {
  baseVersion: plan.version,
  activeGoalId: plan.activeGoalId,
  goalOrder: plan.goals.map((goal) => goal.goalId),
  goalUpdates: [],
});
assert.equal(ignoredModelNoOp.ok, true, '模型边界应把整份等价空补丁视为未提供');
assert.equal(ignoredModelNoOp.plan.version, plan.version, '忽略空补丁不得增加计划版本');
const ignoredAnswerNoOp = applySearchPlanAnswerAction(plan, {
  type: 'answer',
  answer: '保留当前部分结论。',
  citations: ['e1'],
  completeness: 'partial',
  planPatch: {
    baseVersion: plan.version,
    activeGoalId: plan.activeGoalId,
    goalOrder: plan.goals.map((goal) => goal.goalId),
    goalUpdates: [],
  },
}, { evidenceIds: EVIDENCE_IDS });
assert.equal(ignoredAnswerNoOp.ok, true, '最终 answer 的等价空补丁也应视为 planPatch=null');
assert.equal(ignoredAnswerNoOp.plan.version, plan.version);
rejectPatch(plan, { baseVersion: plan.version, goalUpdates: [{ goalId: 'goal-1', status: 'partial' }] }, 'no-op-goal-update');
rejectPatch(plan, { baseVersion: plan.version, goalUpdates: [
  { goalId: 'goal-1', status: 'searching' },
  { goalId: 'goal-1', status: 'searching' },
] }, 'duplicate-goal-update');
rejectPatch(plan, { baseVersion: plan.version, status: 'completed', goalUpdates: [] }, 'unexpected-field');

const multiUpdated = apply(makePlan({ goals: [makeGoal('goal-1'), makeGoal('goal-2')] }), {
  baseVersion: 1,
  goalUpdates: [
    { goalId: 'goal-1', status: 'searching' },
    { goalId: 'goal-2', status: 'searching' },
  ],
});
assert.equal(multiUpdated.goalUpdateCount, 2, '每个 goalUpdate 各增加一次计数');
const updateLimited = structuredClone(multiUpdated);
updateLimited.goalUpdateCount = 8;
rejectPatch(updateLimited, { baseVersion: updateLimited.version, goalUpdates: [{ goalId: 'goal-2', status: 'partial' }] }, 'goal-update-limit');

const switched = apply(makePlan({ goals: [makeGoal('goal-1'), makeGoal('goal-2')] }), {
  baseVersion: 1,
  activeGoalId: 'goal-2',
  goalUpdates: [],
});
assert.equal(switched.activeGoalId, 'goal-2');
const reordered = apply(switched, { baseVersion: 2, goalOrder: ['goal-2', 'goal-1'], goalUpdates: [] });
assert.deepEqual(reordered.goals.map((goal) => goal.goalId), ['goal-2', 'goal-1']);
assert.equal(reordered.revisionCount, 1);
rejectPatch(reordered, { baseVersion: 3, goalOrder: ['goal-2', 'goal-2'], goalUpdates: [] }, 'invalid-goal-order');
rejectPatch(reordered, { baseVersion: 3, activeGoalId: null, goalUpdates: [] }, 'active-goal-clear-forbidden');

// Reopening consumes one revision and query variants are source-bound/deduplicated; only each patch is capped.
let variantPlan = startSearching(makePlan());
variantPlan = apply(variantPlan, {
  baseVersion: variantPlan.version,
  goalUpdates: [{
    goalId: 'goal-1',
    status: 'partial',
    evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }],
  }],
});
variantPlan = apply(variantPlan, {
  baseVersion: variantPlan.version,
  goalUpdates: [{
    goalId: 'goal-1',
    status: 'searching',
    queryVariants: [
      { term: 'Beta', source: 'search-observation' },
      { term: 'Gamma', source: 'model-synonym' },
    ],
  }],
});
assert.equal(variantPlan.revisionCount, 1);
assert.deepEqual(variantPlan.goals[0].queryTerms.slice(-2), [
  { term: 'beta', source: 'search-observation' },
  { term: 'gamma', source: 'model-synonym' },
]);
variantPlan = apply(variantPlan, {
  baseVersion: variantPlan.version,
  goalUpdates: [{
    goalId: 'goal-1',
    status: 'searching',
    queryVariants: [
      { term: 'Delta', source: 'note-map' },
      { term: 'Epsilon', source: 'user-confirmed' },
      { term: 'Zeta', source: 'model-synonym' },
      { term: 'Eta', source: 'model-synonym' },
    ],
  }],
});
assert.equal(variantPlan.revisionCount, 2);
assert.equal(variantPlan.goals[0].queryTerms.length, 7, '不同补丁累计的 QueryTerm 不再受生命周期数量限制。');
rejectPatch(variantPlan, {
  baseVersion: variantPlan.version,
  goalUpdates: [{ goalId: 'goal-1', status: 'searching', queryVariants: [{ term: 'alpha', source: 'planner' }] }],
}, 'invalid-enum');
rejectPatch(variantPlan, {
  baseVersion: variantPlan.version,
  goalUpdates: [{ goalId: 'goal-1', status: 'searching', queryVariants: [
    { term: 'zeta', source: 'note-map' },
    { term: 'zeta', source: 'note-map' },
  ] }],
}, 'duplicate-query-variant');
let revisionLimited = startSearching(makePlan());
revisionLimited = apply(revisionLimited, {
  baseVersion: revisionLimited.version,
  goalUpdates: [{ goalId: 'goal-1', status: 'partial' }],
});
revisionLimited.revisionCount = 2;
rejectPatch(revisionLimited, {
  baseVersion: revisionLimited.version,
  goalUpdates: [{ goalId: 'goal-1', status: 'searching', queryVariants: [{ term: 'zeta', source: 'note-map' }] }],
}, 'invalid-goal-transition');

// Evidence bindings are full replacements, scoped, distinct and atomic.
let evidencePlan = startSearching(makePlan());
const noScopeEvidence = applySearchPlanPatch(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }] }],
}, { now: NOW });
assert.equal(noScopeEvidence.ok, false);
assert.equal(noScopeEvidence.code, 'evidence-scope-required');
rejectPatch(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1', 'e1'] }] }],
}, 'duplicate-evidence-id');
rejectPatch(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['forged'] }] }],
}, 'unknown-evidence-id');
rejectPatch(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5'] }] }],
}, 'invalid-evidence-count');
rejectPatch(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [
    { requirementId: 'goal-1-r1', evidenceIds: ['e1'] },
    { requirementId: 'goal-1-r1', evidenceIds: ['e2'] },
  ] }],
}, 'duplicate-binding-requirement');
const minTwoPlan = startSearching(makePlan({ goals: [makeGoal('goal-1', { minEvidence: 2 })] }));
rejectPatch(minTwoPlan, {
  baseVersion: minTwoPlan.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'covered', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }] }],
}, 'insufficient-evidence');
evidencePlan = apply(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{
    goalId: 'goal-1',
    status: 'partial',
    evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1', 'e2'] }],
    missingEvidence: '待补充',
  }],
});
evidencePlan = apply(evidencePlan, {
  baseVersion: evidencePlan.version,
  goalUpdates: [{ goalId: 'goal-1', evidenceBindings: [], missingEvidence: null }],
});
assert.deepEqual(evidencePlan.goals[0].evidenceBindings, []);
assert.equal('missingEvidence' in evidencePlan.goals[0], false);
const coveredPlan = apply(startSearching(makePlan()), {
  baseVersion: 2,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'covered', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }] }],
});
assert.equal(coveredPlan.goals[0].status, 'covered');
rejectPatch(coveredPlan, { baseVersion: coveredPlan.version, goalUpdates: [{ goalId: 'goal-1', status: 'partial' }] }, 'covered-goal-immutable');

// Conflict bindings require both non-overlapping sides and are independent of ordinary bindings.
const conflictBase = startSearching(makePlan());
rejectPatch(conflictBase, {
  baseVersion: conflictBase.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'conflicted', conflictBindings: [{ requirementId: 'goal-1-r1', supportsEvidenceIds: [], contradictsEvidenceIds: ['e2'] }] }],
}, 'invalid-evidence-count');
rejectPatch(conflictBase, {
  baseVersion: conflictBase.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'conflicted', conflictBindings: [{ requirementId: 'goal-1-r1', supportsEvidenceIds: ['e1'], contradictsEvidenceIds: ['e1'] }] }],
}, 'overlapping-conflict-evidence');
rejectPatch(conflictBase, {
  baseVersion: conflictBase.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'conflicted', conflictBindings: [{ requirementId: 'goal-1-r1', supportsEvidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5'], contradictsEvidenceIds: ['e6'] }] }],
}, 'invalid-evidence-count');
const conflictedPlan = apply(conflictBase, {
  baseVersion: conflictBase.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'conflicted', conflictBindings: [{ requirementId: 'goal-1-r1', supportsEvidenceIds: ['e1', 'e2'], contradictsEvidenceIds: ['e3'] }] }],
});
assert.equal(conflictedPlan.goals[0].status, 'conflicted');
assert.deepEqual(conflictedPlan.goals[0].conflictBindings[0].supportsEvidenceIds, ['e1', 'e2']);
rejectPatch(conflictedPlan, {
  baseVersion: conflictedPlan.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-1', status: 'covered', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }] }],
}, 'invalid-covered-goal');
const reopenedConflict = apply(conflictedPlan, {
  baseVersion: conflictedPlan.version,
  activeGoalId: 'goal-1',
  goalUpdates: [{ goalId: 'goal-1', status: 'searching', queryVariants: [{ term: 'delta', source: 'search-observation' }], conflictBindings: [] }],
});
assert.equal(reopenedConflict.goals[0].status, 'searching');
assert.deepEqual(reopenedConflict.goals[0].conflictBindings, []);

// Atomic rejection: unknown goal/evidence/invalid state leaves every field untouched.
const atomicBase = startSearching(makePlan({ goals: [makeGoal('goal-1'), makeGoal('goal-2')] }));
const atomicBefore = JSON.stringify(atomicBase);
const atomicResult = applySearchPlanPatch(atomicBase, {
  baseVersion: atomicBase.version,
  goalUpdates: [
    { goalId: 'goal-1', status: 'partial' },
    { goalId: 'goal-forged', status: 'searching' },
  ],
}, { evidenceIds: EVIDENCE_IDS, now: NOW });
assert.equal(atomicResult.ok, false);
assert.equal(JSON.stringify(atomicBase), atomicBefore);

// Final answer patch is one atomic operation; coverage is checked before complete is accepted.
const answerBase = startSearching(makePlan());
const answerResult = applySearchPlanAnswerAction(answerBase, {
  type: 'answer',
  answer: '已完成',
  completeness: 'complete',
  citations: ['e1'],
  planPatch: {
    baseVersion: answerBase.version,
    activeGoalId: null,
    goalUpdates: [{ goalId: 'goal-1', status: 'covered', evidenceBindings: [{ requirementId: 'goal-1-r1', evidenceIds: ['e1'] }] }],
  },
}, { evidenceIds: EVIDENCE_IDS, now: NOW });
assert.equal(answerResult.ok, true);
assert.equal(answerResult.plan.goals[0].status, 'covered');
const invalidAnswer = applySearchPlanAnswerAction(answerBase, {
  type: 'answer',
  answer: '伪造完成',
  completeness: 'complete',
  planPatch: { baseVersion: answerBase.version, activeGoalId: null, goalUpdates: [{ goalId: 'goal-1', status: 'covered' }] },
}, { evidenceIds: EVIDENCE_IDS, now: NOW });
assert.equal(invalidAnswer.ok, false);
assert.equal(answerBase.goals[0].status, 'searching', 'answer 拒绝后原计划保持不变');

// Controller lifecycle is independent from goal status and is not patchable by model data.
const completed = setSearchPlanControllerStatus(coveredPlan, 'completed', { now: NOW });
assert.equal(completed.status, 'completed');
assert.equal(completed.activeGoalId, null);
assertValidSearchPlan(completed);
const stale = markSearchPlanStale(completed, NOW);
assert.equal(stale.status, 'stale');
rejectThrow(() => setSearchPlanControllerStatus(makePlan(), 'completed', { now: NOW }), 'incomplete-plan');

console.log('SearchPlan contract verification passed');
