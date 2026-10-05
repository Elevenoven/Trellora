import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-plan-execute-stage4');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const validationFile = path.join(outDir, 'validation.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanValidation.ts')], outfile: validationFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { applySearchPlanAnswerAction, applySearchPlanPatch, createSearchPlan, setSearchPlanControllerStatus } = await import(pathToFileURL(validationFile).href);

const markdown = `# 对照夹具

${Array.from({ length: 220 }, (_, index) => `背景索引 ${index + 1}：阶段 4 只验证当前笔记原文证据。`).join('\n')}

## 项目 A

项目 A 的部署策略是蓝绿发布，证据对象为项目 A。

## 项目 B

项目 B 的部署策略是滚动发布，证据对象为项目 B。

## 支持事实

支持证据：该配置在当前版本中已启用。

## 反对事实

反对证据：旧版本记录显示该配置曾经关闭。
`;
const lines = markdown.split('\n');
const lineOf = (text) => lines.indexOf(text) + 1;
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/stage4.md',
  title: '阶段 4 夹具',
  contentHash,
  markdown,
  headings: [
    { id: 'root', level: 1, text: '对照夹具', line: 1 },
    { id: 'a', level: 2, text: '项目 A', line: lineOf('## 项目 A') },
    { id: 'b', level: 2, text: '项目 B', line: lineOf('## 项目 B') },
    { id: 'support', level: 2, text: '支持事实', line: lineOf('## 支持事实') },
    { id: 'against', level: 2, text: '反对事实', line: lineOf('## 反对事实') },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});

const linesFor = (headingId) => {
  const heading = snapshot.headings.find((candidate) => candidate.headingId === headingId);
  assert.ok(heading, `heading ${headingId} exists`);
  return { lineFrom: heading.lineFrom, lineTo: Math.min(snapshot.lineCount, heading.lineFrom + 2) };
};

function plannerFor(output) {
  let calls = 0;
  const driver = createCurrentNotePlanDriver({
    async generateJson() {
      calls += 1;
      return output;
    },
  });
  return { driver, get calls() { return calls; } };
}

function promptContext(prompt) {
  const evidenceIds = [...new Set([...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]))];
  return {
    goalId: prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1],
    version: Number(prompt.match(/planVersion=(\d+)/u)?.[1]),
    evidenceIds,
  };
}

function tool(prompt, toolName, argumentsValue, planPatch) {
  const context = promptContext(prompt);
  return {
    type: 'tool',
    goalId: context.goalId,
    tool: toolName,
    arguments: argumentsValue,
    publicRationale: `阶段 4 测试：${toolName}`,
    ...(planPatch ? { planPatch } : {}),
  };
}

function answer(prompt, completeness, planPatch) {
  const context = promptContext(prompt);
  return {
    type: 'answer',
    answer: `阶段 4 ${completeness}`,
    citations: context.evidenceIds,
    completeness,
    ...(planPatch ? { planPatch } : {}),
  };
}

function agentInput(question, planner, driver, suffix, extra = {}) {
  return {
    snapshot,
    question,
    conversation: [],
    providerKind: 'ollama',
    model: 'qwen3',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver,
    planner: planner.driver,
    planMode: 'current-note',
    memory: new NoteConversationMemory(),
    memoryScopeKey: `stage4:${suffix}`,
    isSnapshotCurrent: () => true,
    ...extra,
  };
}

function createDriver(decide, synthesize) {
  let decisionCalls = 0;
  let synthesisCalls = 0;
  const actions = [];
  return {
    get decisionCalls() { return decisionCalls; },
    get synthesisCalls() { return synthesisCalls; },
    actions,
    async decide(input) {
      decisionCalls += 1;
      const action = decide(decisionCalls, input.prompt);
      actions.push(action);
      return action;
    },
    async synthesize(input) {
      synthesisCalls += 1;
      if (synthesize) return synthesize(input);
      const terminationAction = actions.at(-1);
      return terminationAction?.type === 'answer'
        ? terminationAction
        : answer(input.prompt, 'partial');
    },
  };
}

const twoGoalOutput = {
  goals: [
    {
      goalId: 'goal-a',
      question: '核实项目 A 的部署策略。',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'req-a', label: '项目 A 的部署策略', subject: '项目 A', minEvidence: 1 }],
      queryTerms: ['项目 A', '蓝绿发布'],
    },
    {
      goalId: 'goal-b',
      question: '核实项目 B 的部署策略。',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'req-b', label: '项目 B 的部署策略', subject: '项目 B', minEvidence: 1 }],
      queryTerms: ['项目 B', '滚动发布'],
    },
  ],
};

// Natural two-goal order: search A -> read A -> search B -> read B -> answer.
// The third model action must reach the real B search tool after covering A;
// observing the model action alone is not enough to prove controller behavior.
const twoGoalPlanner = plannerFor(twoGoalOutput);
const twoGoalDriver = createDriver((count, prompt) => {
  const context = promptContext(prompt);
  if (count === 1) return tool(prompt, 'search_note', { terms: ['项目 A'] });
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('a'));
  if (count === 3) {
    return { ...tool(prompt, 'search_note', { terms: ['项目 B'] }, {
      baseVersion: context.version,
      activeGoalId: 'goal-b',
      goalUpdates: [],
    }), goalId: 'goal-b' };
  }
  if (count === 4) return tool(prompt, 'read_note_range', linesFor('b'));
  if (count === 5) {
    const evidenceId = context.evidenceIds.at(-1);
    return answer(prompt, 'complete', {
      baseVersion: context.version,
      activeGoalId: null,
      goalUpdates: [
        { goalId: 'goal-a', status: 'covered', evidenceBindings: [{ requirementId: 'req-a', evidenceIds: [context.evidenceIds[0]] }] },
        { goalId: 'goal-b', status: 'covered', evidenceBindings: [{ requirementId: 'req-b', evidenceIds: [evidenceId] }] },
      ],
    });
  }
  throw new Error('two-goal flow should finish after the natural five-decision sequence');
});
const twoGoalEvents = [];
const twoGoal = await runCurrentNoteAgent(agentInput('分别核实项目 A 和项目 B 的部署策略。', twoGoalPlanner, twoGoalDriver, 'two-goal', { onToolEvent: (event) => twoGoalEvents.push(event) }));
assert.equal(twoGoalPlanner.calls, 1);
assert.equal(twoGoalDriver.decisionCalls, 5, JSON.stringify({ stats: twoGoal.agentStats, toolStats: twoGoal.toolStats, plan: twoGoal.searchPlan, answer: twoGoal.answer, events: twoGoalEvents, actions: twoGoalDriver.actions }));
assert.equal(twoGoalDriver.synthesisCalls, 1, 'Decision answer 只终止检索，最终 action 必须来自 Synthesize');
assert.equal(twoGoal.toolStats.calls, 4);
const twoGoalSearches = twoGoalEvents.filter((event) => event.tool === 'search_note' && event.state === 'started');
assert.equal(twoGoalSearches.length, 2, '两个目标的合法搜索动作都必须真正启动，不能被第一条证据提前拦截');
assert.ok(['项目 a', '蓝绿发布'].every((term) => twoGoalSearches[0]?.inputSummary?.includes(term)), '目标 A 搜索必须使用目标 A 的稳定 Planner QueryTerm。');
assert.ok(['项目 b', '滚动发布'].every((term) => twoGoalSearches[1]?.inputSummary?.includes(term)), '目标 B 搜索必须使用目标 B 的稳定 Planner QueryTerm。');
assert.equal(twoGoalSearches[0]?.inputSummary?.includes('项目 b'), false, '单目标执行不能把其他 goal 的 QueryTerm 混入当前搜索。');
assert.equal(twoGoalSearches[1]?.inputSummary?.includes('项目 a'), false, '切换 goal 后不能继续携带前一目标的 QueryTerm。');
assert.equal(twoGoal.completeness, 'complete');
assert.equal(twoGoal.searchPlan?.status, 'completed');
assert.deepEqual(twoGoal.searchPlan?.goals.map((goal) => goal.status), ['covered', 'covered']);

// Structured Outputs may still materialize an object equivalent to a null
// planPatch. It must not block the requested tool or consume an invalid action.
const noOpPatchPlanner = plannerFor({ goals: [{
  goalId: 'goal-no-op-patch',
  question: '读取支持事实。',
  evidenceKind: 'fact',
  requirements: [{ requirementId: 'req-no-op-patch', label: '支持事实原文', minEvidence: 1 }],
  queryTerms: ['支持事实'],
}] });
const noOpPatchEvents = [];
const noOpPatchDriver = createDriver((count, prompt) => {
  const context = promptContext(prompt);
  if (count === 1) {
    return tool(prompt, 'search_note', { terms: ['支持事实'] }, {
      baseVersion: context.version,
      activeGoalId: context.goalId,
      goalOrder: [context.goalId],
      goalUpdates: [],
    });
  }
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('support'));
  return answer(prompt, 'partial');
});
const noOpPatchResult = await runCurrentNoteAgent(agentInput('读取支持事实。', noOpPatchPlanner, noOpPatchDriver, 'no-op-patch', { onToolEvent: (event) => noOpPatchEvents.push(event) }));
assert.equal(noOpPatchResult.evidence.length, 1, JSON.stringify({
  message: '等价空补丁不能阻断原文读取',
  result: noOpPatchResult,
  events: noOpPatchEvents,
  actions: noOpPatchDriver.actions,
}));
assert.equal(noOpPatchEvents.filter((event) => event.tool === 'read_note_range' && event.state === 'completed').length, 1);
assert.equal(noOpPatchEvents.filter((event) => event.state === 'rejected').length, 0, '等价空补丁不得消耗 invalid-action 重试');

// Comparison requirements retain distinct subject evidence.
const comparisonOutput = {
  goals: [{
    goalId: 'goal-comparison',
    question: '比较项目 A 与项目 B 的部署策略。',
    evidenceKind: 'comparison',
    requirements: [
      { requirementId: 'req-comparison-a', label: '项目 A 的部署策略', subject: '项目 A', minEvidence: 1 },
      { requirementId: 'req-comparison-b', label: '项目 B 的部署策略', subject: '项目 B', minEvidence: 1 },
    ],
    queryTerms: ['项目 A', '项目 B'],
  }],
};
const comparisonPlanner = plannerFor(comparisonOutput);
const comparisonEvents = [];
const comparisonDriver = createDriver((count, prompt) => {
  if (count === 1) return tool(prompt, 'search_note', { terms: ['项目 A'] });
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('a'));
  if (count === 3) return tool(prompt, 'search_note', { terms: ['项目 B'] });
  if (count === 4) return tool(prompt, 'read_note_range', linesFor('b'));
  const context = promptContext(prompt);
  return answer(prompt, 'complete', {
    baseVersion: context.version,
    activeGoalId: null,
    goalUpdates: [{
      goalId: 'goal-comparison',
      status: 'covered',
      evidenceBindings: [
        { requirementId: 'req-comparison-a', evidenceIds: [context.evidenceIds[0]] },
        { requirementId: 'req-comparison-b', evidenceIds: [context.evidenceIds.at(-1)] },
      ],
    }],
  });
});
const comparison = await runCurrentNoteAgent(agentInput('比较项目 A 与项目 B 的部署策略。', comparisonPlanner, comparisonDriver, 'comparison', { onToolEvent: (event) => comparisonEvents.push(event) }));
const comparisonSearches = comparisonEvents.filter((event) => event.tool === 'search_note' && event.state === 'started');
assert.equal(comparisonSearches.length, 1, '同一 goal 的 QueryTerm 已在首批执行完时不得重复启动等价搜索');
assert.ok(['项目 a', '项目 b'].every((term) => comparisonSearches[0]?.inputSummary?.includes(term)), 'comparison 首批搜索必须直接复用目标内的全部 QueryTerm。');
assert.equal(comparison.completeness, 'complete');
assert.equal(comparison.searchPlan?.status, 'completed');
const comparisonBindings = comparison.searchPlan?.goals[0].evidenceBindings ?? [];
assert.notEqual(comparisonBindings[0].evidenceIds[0], comparisonBindings[1].evidenceIds[0]);

// Final-answer evidence bindings are no longer an answer gate. The model owns
// the returned completeness; SearchPlan mirrors a structurally valid patch.
const sharedEvidencePlanner = plannerFor(comparisonOutput);
const sharedEvidenceDriver = createDriver((count, prompt) => {
  if (count === 1) return tool(prompt, 'search_note', { terms: ['项目 A'] });
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('a'));
  const context = promptContext(prompt);
  const sharedEvidenceId = context.evidenceIds.at(-1);
  return answer(prompt, 'complete', {
    baseVersion: context.version,
    activeGoalId: null,
    goalUpdates: [{
      goalId: 'goal-comparison',
      status: 'covered',
      evidenceBindings: [
        { requirementId: 'req-comparison-a', evidenceIds: [sharedEvidenceId] },
        { requirementId: 'req-comparison-b', evidenceIds: [sharedEvidenceId] },
      ],
    }],
  });
});
const sharedEvidence = await runCurrentNoteAgent(agentInput('比较项目 A 与项目 B 的部署策略。', sharedEvidencePlanner, sharedEvidenceDriver, 'shared-evidence'));
assert.equal(sharedEvidence.completeness, 'complete', '模型 complete 不再由 comparison 证据校验器降级');
assert.equal(sharedEvidence.searchPlan?.status, 'completed');

// A complete answer cannot atomically cover only one of two goals.
const incompletePlanner = plannerFor(twoGoalOutput);
const incompleteDriver = createDriver((count, prompt) => {
  if (count === 1) return tool(prompt, 'search_note', { terms: ['项目 A'] });
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('a'));
  const context = promptContext(prompt);
  return answer(prompt, 'complete', {
    baseVersion: context.version,
    activeGoalId: null,
    goalUpdates: [{ goalId: 'goal-a', status: 'covered', evidenceBindings: [{ requirementId: 'req-a', evidenceIds: [context.evidenceIds.at(-1)] }] }],
  });
});
const incomplete = await runCurrentNoteAgent(agentInput('只核实项目 A。', incompletePlanner, incompleteDriver, 'incomplete'));
assert.equal(incomplete.completeness, 'complete', '部分 SearchPlan 补丁不得改写模型答案');
assert.notEqual(incomplete.searchPlan?.status, 'completed');
assert.equal(incomplete.searchPlan?.goals.some((goal) => goal.status === 'covered'), false, '无法形成合法终态的局部 planPatch 只被 SearchPlan 投影忽略');

// One requirement can remain conflicted while both sides stay cited.
const conflictOutput = {
  goals: [{
    goalId: 'goal-conflict',
    question: '核实该配置是否启用。',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-conflict', label: '配置启用状态', minEvidence: 1 }],
    queryTerms: ['配置', '启用'],
  }],
};
const conflictPlanner = plannerFor(conflictOutput);
const conflictDriver = createDriver((count, prompt) => {
  if (count === 1) return tool(prompt, 'search_note', { terms: ['配置', '启用'] });
  if (count === 2) return tool(prompt, 'read_note_range', linesFor('support'));
  if (count === 3) return tool(prompt, 'read_note_range', linesFor('against'));
  const context = promptContext(prompt);
  return answer(prompt, 'partial', {
    baseVersion: context.version,
    activeGoalId: null,
    goalUpdates: [{
      goalId: 'goal-conflict',
      status: 'conflicted',
      conflictBindings: [{ requirementId: 'req-conflict', supportsEvidenceIds: [context.evidenceIds[0]], contradictsEvidenceIds: [context.evidenceIds.at(-1)] }],
    }],
  });
});
const conflict = await runCurrentNoteAgent(agentInput('该配置是否启用？', conflictPlanner, conflictDriver, 'conflict'));
assert.equal(conflict.completeness, 'partial');
assert.equal(conflict.searchPlan?.status, 'partial');
assert.equal(conflict.searchPlan?.goals[0].status, 'conflicted');
assert.equal(conflict.searchPlan?.goals[0].conflictBindings[0].supportsEvidenceIds.length, 1);
assert.equal(conflict.searchPlan?.goals[0].conflictBindings[0].contradictsEvidenceIds.length, 1);
assert.equal(conflict.evidence.length, 2);

// Navigation cannot directly claim coverage, even when an older read exists.
const navigationPlanner = plannerFor(conflictOutput);
const navigationDriver = createDriver((count, prompt) => {
  if (count === 1) return tool(prompt, 'read_note_range', linesFor('support'));
  const context = promptContext(prompt);
  return tool(prompt, 'search_note', { terms: ['配置'] }, {
    baseVersion: context.version,
    activeGoalId: context.goalId,
    goalUpdates: [{ goalId: context.goalId, status: 'covered', evidenceBindings: [{ requirementId: 'req-conflict', evidenceIds: [context.evidenceIds.at(-1)] }] }],
  });
});
const navigationEvents = [];
const navigation = await runCurrentNoteAgent(agentInput('检查配置导航。', navigationPlanner, navigationDriver, 'navigation', { onToolEvent: (event) => navigationEvents.push(event) }));
assert.equal(navigationEvents.filter((event) => event.tool === 'search_note' && event.message === '阶段 4 测试：search_note').length, 0, '被拒绝的导航动作不能执行工具');
assert.notEqual(navigation.searchPlan?.status, 'completed');

const forgedGoalPlanner = plannerFor(conflictOutput);
const forgedGoalEvents = [];
const forgedGoalDriver = createDriver((count, prompt) => {
  if (count === 1) return { ...tool(prompt, 'search_note', { terms: ['配置'] }), goalId: 'goal-forged' };
  return answer(prompt, 'partial');
});
const forgedGoal = await runCurrentNoteAgent(agentInput('拒绝伪造目标。', forgedGoalPlanner, forgedGoalDriver, 'forged-goal', { onToolEvent: (event) => forgedGoalEvents.push(event) }));
assert.equal(forgedGoalEvents.some((event) => event.tool === 'search_note' && event.state === 'started' && event.message === '阶段 4 测试：search_note'), false, '伪造 goalId 的工具动作不得执行');
assert.notEqual(forgedGoal.searchPlan?.status, 'completed');

// Two revisions are accepted; the third variant is rejected without a third revision.
const replanPlanner = plannerFor({ goals: [{
  goalId: 'goal-replan',
  question: '查找 alpha 配置。',
  evidenceKind: 'fact',
  requirements: [{ requirementId: 'req-replan', label: 'alpha 配置', minEvidence: 1 }],
  queryTerms: ['alpha'],
}] });
const replanDriver = createDriver((count, prompt) => {
  const context = promptContext(prompt);
  if (count === 1) return tool(prompt, 'search_note', { terms: ['alpha'] });
  if (count <= 4) return tool(prompt, 'search_note', { terms: [count === 2 ? 'beta' : count === 3 ? 'gamma' : 'delta'] }, {
    baseVersion: context.version,
    activeGoalId: context.goalId,
    goalUpdates: [{ goalId: context.goalId, status: 'searching', queryVariants: [{ term: count === 2 ? 'beta' : count === 3 ? 'gamma' : 'delta', source: 'model-synonym' }] }],
  });
  return answer(prompt, 'partial');
});
const replan = await runCurrentNoteAgent(agentInput('查找 alpha 配置。', replanPlanner, replanDriver, 'replan'));
assert.equal(replan.searchPlan?.revisionCount, 2);
assert.ok(replan.searchPlan?.goals[0].queryTerms.some((term) => term.term === 'beta'));
assert.ok(replan.searchPlan?.goals[0].queryTerms.some((term) => term.term === 'gamma'));
assert.equal(replan.searchPlan?.goals[0].queryTerms.some((term) => term.term === 'delta'), false);

// Exhausted act rounds still reserve synthesis; its answer is authoritative.
const budgetPlanner = plannerFor({ goals: [{
  goalId: 'goal-budget',
  question: '查找不存在的词。',
  evidenceKind: 'fact',
  requirements: [{ requirementId: 'req-budget', label: '不存在的证据', minEvidence: 1 }],
  queryTerms: ['不存在的词'],
}] });
const budgetDriver = createDriver((_, prompt) => tool(prompt, 'search_note', { terms: ['不存在的词'] }), async ({ prompt }) => answer(prompt, 'complete'));
const budgetResult = await runCurrentNoteAgent(agentInput('查找不存在的词。', budgetPlanner, budgetDriver, 'budget'));
assert.equal(budgetResult.completeness, 'complete');
assert.equal(budgetResult.answer, '阶段 4 complete');
assert.equal(budgetResult.searchPlan?.status, 'partial');
assert.ok(budgetResult.agentStats.modelCalls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxModelCalls);
assert.ok(budgetResult.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

// Pure contract checks remain part of the stage-4 gate: stale versions,
// malformed orders, terminal rollback, forged IDs and answer atomicity.
const basePlan = createSearchPlan({ originalQuestion: '契约', goals: [{
  goalId: 'goal-contract',
  question: '契约目标',
  evidenceKind: 'fact',
  requirements: [{ requirementId: 'req-contract', label: '契约证据', minEvidence: 1 }],
  queryTerms: ['契约'],
}] }, { planId: 'plan-contract', now: '2026-08-22T00:00:00.000Z' });
const started = applySearchPlanPatch(basePlan, { baseVersion: 1, goalUpdates: [{ goalId: 'goal-contract', status: 'searching' }] });
assert.equal(started.ok, true);
const planAfterStart = started.plan;
const partialTerminal = setSearchPlanControllerStatus(planAfterStart, 'partial', { now: '2026-08-22T00:00:00.000Z' });
assert.equal(partialTerminal.activeGoalId, null);
assert.equal(partialTerminal.goals[0].status, 'partial', '终止的 partial 计划不能保留 searching goal');
const notFoundTerminal = setSearchPlanControllerStatus(basePlan, 'not-found', { now: '2026-08-22T00:00:00.000Z' });
assert.equal(notFoundTerminal.activeGoalId, null);
assert.equal(notFoundTerminal.goals[0].status, 'not-found', '终止的 not-found 计划不能保留 pending goal');
for (const [patch, code] of [
  [{ baseVersion: 1, goalUpdates: [{ goalId: 'goal-contract', status: 'partial' }] }, 'stale-base-version'],
  [{ baseVersion: planAfterStart.version, goalOrder: ['forged'], goalUpdates: [] }, 'invalid-goal-order'],
  [{ baseVersion: planAfterStart.version, goalUpdates: [{ goalId: 'goal-forged', status: 'searching' }] }, 'unknown-goal-id'],
  [{ baseVersion: planAfterStart.version, activeGoalId: null, goalUpdates: [{ goalId: 'goal-contract', status: 'covered', evidenceBindings: [{ requirementId: 'req-contract', evidenceIds: ['forged'] }] }] }, 'unknown-evidence-id'],
]) {
  const result = applySearchPlanPatch(planAfterStart, patch, { evidenceIds: new Set(['evidence-real']) });
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}
const covered = applySearchPlanPatch(planAfterStart, {
  baseVersion: planAfterStart.version,
  activeGoalId: null,
  goalUpdates: [{ goalId: 'goal-contract', status: 'covered', evidenceBindings: [{ requirementId: 'req-contract', evidenceIds: ['evidence-real'] }] }],
}, { evidenceIds: new Set(['evidence-real']) });
assert.equal(covered.ok, true);
const rollback = applySearchPlanPatch(covered.plan, { baseVersion: covered.plan.version, goalUpdates: [{ goalId: 'goal-contract', status: 'searching' }] }, { evidenceIds: new Set(['evidence-real']) });
assert.equal(rollback.ok, false);
assert.equal(rollback.code, 'covered-goal-immutable');
const terminal = setSearchPlanControllerStatus(covered.plan, 'completed', { now: '2026-08-22T00:00:00.000Z' });
const terminalRollback = applySearchPlanPatch(terminal, { baseVersion: terminal.version, goalUpdates: [{ goalId: 'goal-contract', status: 'searching' }] }, { evidenceIds: new Set(['evidence-real']) });
assert.equal(terminalRollback.ok, false);
assert.equal(terminalRollback.code, 'plan-not-active');
const invalidAnswer = applySearchPlanAnswerAction(planAfterStart, {
  type: 'answer', answer: '伪造 complete', citations: ['evidence-real'], completeness: 'complete',
  planPatch: { baseVersion: planAfterStart.version, activeGoalId: null, goalUpdates: [{ goalId: 'goal-contract', status: 'covered' }] },
}, { evidenceIds: new Set(['evidence-real']) });
assert.equal(invalidAnswer.ok, false);
assert.equal(planAfterStart.goals[0].status, 'searching');

console.log('Current-note SearchPlan execution P4 verification passed');
