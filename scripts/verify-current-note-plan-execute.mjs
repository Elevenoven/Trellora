import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-plan-execute');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const {
  createCurrentNotePlanDriver,
  createCurrentNotePlanPrompt,
  deriveCurrentNoteFallbackQueryTerms,
  createFallbackCurrentNotePlan,
  shouldUseCurrentNotePlanner,
} = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);

const markdown = `# 总览\n\n${Array.from({ length: 250 }, (_, index) => `前言内容 ${index + 1}。`).join('\n')}\n\n## 尾部证据\n\n尾部唯一结论：受控 ReAct 必须读取原文后才能回答。`;
const lines = markdown.split('\n');
const tailHeadingLine = lines.indexOf('## 尾部证据') + 1;
const conclusionLine = tailHeadingLine + 2;
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/plan.md',
  title: 'Plan 夹具',
  contentHash,
  markdown,
  headings: [
    { id: 'overview', level: 1, text: '总览', line: 1 },
    { id: 'tail', level: 2, text: '尾部证据', line: tailHeadingLine },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
assert.ok(snapshot.markdown.length > 1_200);

const validPlannerOutput = {
  goals: [{
    question: '核实尾部唯一结论。',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'r-tail', label: '必须有一条原文证据证明尾部结论。', minEvidence: 1 }],
    queryTerms: ['尾部结论'],
  }],
};

function createPlanner(output = validPlannerOutput, onCall) {
  let calls = 0;
  const prompts = [];
  const driver = createCurrentNotePlanDriver({
    async generateJson(request) {
      calls += 1;
      prompts.push(request.prompt);
      onCall?.(request);
      return output;
    },
  });
  return { driver, get calls() { return calls; }, prompts };
}

function createEvidenceDriver() {
  let decisions = 0;
  const planContext = (prompt) => ({
    goalId: prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1],
    requirementId: prompt.match(/req=([^\s,]+):/u)?.[1],
    planVersion: Number(prompt.match(/planVersion=(\d+)/u)?.[1]),
    evidenceId: prompt.match(/evidence-[a-f0-9]{24}/u)?.[0],
  });
  return {
    get decisions() { return decisions; },
    async decide({ prompt }) {
    decisions += 1;
      const context = planContext(prompt);
      if (decisions === 1) return { type: 'tool', goalId: context.goalId, tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '定位尾部结论原文。' };
      if (decisions === 2) return { type: 'tool', goalId: context.goalId, tool: 'read_note_range', arguments: { lineFrom: conclusionLine, lineTo: conclusionLine }, publicRationale: '读取命中行原文。' };
      const planPatch = context.goalId && context.requirementId && context.evidenceId && Number.isInteger(context.planVersion)
        ? { baseVersion: context.planVersion, activeGoalId: null, goalUpdates: [{ goalId: context.goalId, status: 'covered', evidenceBindings: [{ requirementId: context.requirementId, evidenceIds: [context.evidenceId] }] }] }
        : undefined;
      return { type: 'answer', answer: '根据已读取原文，尾部结论要求先取证后回答。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'complete', ...(planPatch ? { planPatch } : {}) };
    },
    async synthesize({ prompt }) {
      const context = planContext(prompt);
      const planPatch = context.goalId && context.requirementId && context.evidenceId && Number.isInteger(context.planVersion)
        ? { baseVersion: context.planVersion, activeGoalId: null, goalUpdates: [{ goalId: context.goalId, status: 'covered', evidenceBindings: [{ requirementId: context.requirementId, evidenceIds: [context.evidenceId] }] }] }
        : undefined;
      return { type: 'answer', answer: '根据已读取原文形成回答。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'complete', ...(planPatch ? { planPatch } : {}) };
    },
  };
}

function agentInput(driver, extra = {}) {
  return {
    snapshot,
    question: '尾部结论是什么？',
    conversation: [],
    providerKind: 'ollama',
    model: 'qwen3',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver,
    memory: new NoteConversationMemory(),
    memoryScopeKey: 'window-1:plan',
    isSnapshotCurrent: () => true,
    ...extra,
  };
}

// The pure eligibility rule covers every fast path without invoking a model.
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'chat', contextMode: 'react-search', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'clarify', contextMode: 'react-search', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'react', contextMode: 'structured-summary', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'react', contextMode: 'direct-full', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'react', contextMode: 'memory-reuse', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'react', contextMode: 'react-search', hasExternalContext: true }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'off', interactionRoute: 'react', contextMode: 'react-search', hasExternalContext: false }), false);
assert.equal(shouldUseCurrentNotePlanner({ planMode: 'current-note', interactionRoute: 'react', contextMode: 'react-search', hasExternalContext: false }), true);

const firstPlanner = createPlanner();
const firstDriver = createEvidenceDriver();
const first = await runCurrentNoteAgent(agentInput(firstDriver, { planMode: 'current-note', planner: firstPlanner.driver }));
assert.equal(first.route, 'react-search');
assert.equal(first.searchPlan?.goals.length, 1, 'A simple fact question gets one goal.');
assert.equal(firstPlanner.calls, 1, 'react-search performs exactly one initial Planner call.');
assert.equal(firstDriver.decisions, 3, '读取原文后必须回到 ReAct，由模型自行决定是否回答。');
assert.equal(first.agentStats.decisionRounds, 4, 'Planner 加三轮 ReAct 决策后由首个 answer 结束。');
assert.equal(first.agentStats.modelCalls, 4);
assert.equal(first.toolStats.calls, 2);
assert.ok(first.agentStats.modelCalls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxModelCalls);
assert.ok(first.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

const aggregatePlannerTermsEvents = [];
const aggregatePlannerTermsPlanEvents = [];
const aggregatePlannerTermsPlanner = createPlanner({
  goals: [
    {
      question: '笔记中如何定义并描述 NER？',
      evidenceKind: 'definition',
      requirements: [{ requirementId: 'r-ner-definition', label: 'NER 定义原文。', minEvidence: 1 }],
      queryTerms: ['NER', '命名实体识别', 'NER模型', '人物实体', '组织实体', '地点实体'],
    },
    {
      question: '笔记中提到的 NER 实现方式有哪些？',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'r-ner-methods', label: 'NER 实现方式原文。', minEvidence: 1 }],
      queryTerms: ['ner', '内置规则识别', 'spaCy', 'transformers ner', '外部配置'],
    },
  ],
});
let aggregatePlannerTermsDecisions = 0;
await runCurrentNoteAgent(agentInput({
  async decide({ prompt }) {
    aggregatePlannerTermsDecisions += 1;
    if (aggregatePlannerTermsDecisions === 1) {
      const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
      return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['去查查'] }, publicRationale: '验证控制器使用 Planner 查询词。' };
    }
    return { type: 'answer', answer: '当前夹具没有对应原文。', citations: [], completeness: 'not-found' };
  },
  async synthesize() { return { type: 'answer', answer: '当前夹具没有对应原文。', citations: [], completeness: 'not-found' }; },
}, {
  question: '请阅读笔记，帮我去查查 NER 是什么？',
  planMode: 'current-note',
  planner: aggregatePlannerTermsPlanner.driver,
  onToolEvent: (event) => aggregatePlannerTermsEvents.push(event),
  onPlanEvent: (event) => aggregatePlannerTermsPlanEvents.push(event),
}));
const aggregateSearchStarted = aggregatePlannerTermsEvents.find((event) => event.tool === 'search_note' && event.state === 'started');
assert.match(aggregateSearchStarted?.inputSummary ?? '', /关键词：ner、命名实体识别、ner模型、人物实体、组织实体、地点实体、内置规则识别、spacy、transformers ner、外部配置/u);
assert.doesNotMatch(aggregateSearchStarted?.inputSummary ?? '', /去查查/u, 'Plan 模式不得执行 Decide 临时改写的查询词。');
assert.deepEqual(
  aggregatePlannerTermsPlanEvents.findLast((event) => event.finalQueryTerms)?.finalQueryTerms,
  ['ner', '命名实体识别', 'ner模型', '人物实体', '组织实体', '地点实体', '内置规则识别', 'spacy', 'transformers ner', '外部配置'],
  '最后查询关键词必须等于全部目标 QueryTerm 的稳定去重结果。',
);

const incompleteCoverageEvents = [];
const incompleteCoveragePlanner = createPlanner();
let incompleteCoverageDecisions = 0;
const incompleteCoveragePlanContext = (prompt) => ({
  goalId: prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1],
  requirementId: prompt.match(/req=([^\s,]+):/u)?.[1],
  planVersion: Number(prompt.match(/planVersion=(\d+)/u)?.[1]),
  evidenceId: prompt.match(/evidence-[a-f0-9]{24}/u)?.[0],
});
const incompleteCoverageResult = await runCurrentNoteAgent(agentInput({
  async decide({ prompt }) {
    incompleteCoverageDecisions += 1;
    const context = incompleteCoveragePlanContext(prompt);
    if (incompleteCoverageDecisions === 1) {
      return { type: 'tool', tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '故意省略 goalId，验证控制器安全补全。' };
    }
    if (incompleteCoverageDecisions === 2) {
      return { type: 'tool', goalId: context.goalId, tool: 'read_note_range', arguments: { lineFrom: conclusionLine, lineTo: conclusionLine }, publicRationale: '读取第一个原文片段。' };
    }
    if (incompleteCoverageDecisions === 3) {
      return { type: 'answer', answer: '模型过早声称已完成。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'complete' };
    }
    if (incompleteCoverageDecisions === 4) {
      return { type: 'tool', goalId: context.goalId, tool: 'read_note_range', arguments: { lineFrom: tailHeadingLine, lineTo: conclusionLine }, publicRationale: '覆盖未完成，继续读取相邻原文。' };
    }
    const planPatch = context.goalId && context.requirementId && context.evidenceId && Number.isInteger(context.planVersion)
      ? { baseVersion: context.planVersion, activeGoalId: null, goalUpdates: [{ goalId: context.goalId, status: 'covered', evidenceBindings: [{ requirementId: context.requirementId, evidenceIds: [context.evidenceId] }] }] }
      : undefined;
    return { type: 'answer', answer: '补充核对后，已根据原文形成完整结论。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'complete', ...(planPatch ? { planPatch } : {}) };
  },
  async synthesize() { throw new Error('覆盖未完成但预算仍可用时，不应直接进入最终合成。'); },
}, {
  planMode: 'current-note',
  planner: incompleteCoveragePlanner.driver,
  onToolEvent: (event) => incompleteCoverageEvents.push(event),
}));
assert.equal(incompleteCoverageResult.completeness, 'complete', '模型 complete 必须原样保留。');
assert.equal(incompleteCoverageResult.answer, '模型过早声称已完成。');
assert.equal(incompleteCoverageDecisions, 3, '首个 answer 必须立即结束，不得由本地覆盖控制器追加决策。');
assert.equal(incompleteCoverageEvents.filter((event) => event.tool === 'read_note_range' && event.state === 'started').length, 1, 'answer 后不得由控制器继续读取原文。');
assert.equal(incompleteCoverageEvents.filter((event) => event.state === 'rejected').length, 0, '单 active goal 下缺失的 goalId 必须安全补全，不应浪费一次工具重试。');

const evidenceNotFoundEvents = [];
const evidenceNotFoundPlanner = createPlanner();
let evidenceNotFoundDecisions = 0;
const evidenceNotFoundResult = await runCurrentNoteAgent(agentInput({
  async decide({ prompt }) {
    evidenceNotFoundDecisions += 1;
    const context = incompleteCoveragePlanContext(prompt);
    if (evidenceNotFoundDecisions === 1) {
      return { type: 'tool', goalId: context.goalId, tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '定位可验证原文。' };
    }
    if (evidenceNotFoundDecisions === 2) {
      return { type: 'tool', goalId: context.goalId, tool: 'read_note_range', arguments: { lineFrom: conclusionLine, lineTo: conclusionLine }, publicRationale: '先读取第一条原文证据。' };
    }
    if (evidenceNotFoundDecisions === 3) {
      return { type: 'answer', answer: '模型错误地声称未找到。', citations: [], completeness: 'not-found' };
    }
    if (evidenceNotFoundDecisions === 4) {
      return { type: 'tool', goalId: context.goalId, tool: 'read_note_range', arguments: { lineFrom: tailHeadingLine, lineTo: conclusionLine }, publicRationale: '已有原文但计划未覆盖，继续读取。' };
    }
    const planPatch = context.goalId && context.requirementId && context.evidenceId && Number.isInteger(context.planVersion)
      ? { baseVersion: context.planVersion, activeGoalId: null, goalUpdates: [{ goalId: context.goalId, status: 'covered', evidenceBindings: [{ requirementId: context.requirementId, evidenceIds: [context.evidenceId] }] }] }
      : undefined;
    return { type: 'answer', answer: '已根据继续读取的原文形成完整结论。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'complete', ...(planPatch ? { planPatch } : {}) };
  },
  async synthesize() { throw new Error('已有原文的 premature not-found 不能直接进入最终合成。'); },
}, {
  planMode: 'current-note',
  planner: evidenceNotFoundPlanner.driver,
  onToolEvent: (event) => evidenceNotFoundEvents.push(event),
}));
assert.equal(evidenceNotFoundResult.completeness, 'not-found', '模型 not-found 必须原样保留。');
assert.equal(evidenceNotFoundResult.answer, '模型错误地声称未找到。');
assert.equal(evidenceNotFoundDecisions, 3, 'not-found answer 必须立即结束。');
assert.equal(evidenceNotFoundEvents.filter((event) => event.tool === 'read_note_range' && event.state === 'started').length, 1, 'not-found answer 后不得自动补读。');

const prematurePlannerEvents = [];
const prematurePlanner = createPlanner();
const prematurePlannerDriver = {
  async decide() {
    return { type: 'answer', answer: '证据不足。', citations: [], completeness: 'not-found' };
  },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '自动恢复后读取到了尾部结论。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
};
const prematurePlannerResult = await runCurrentNoteAgent(agentInput(prematurePlannerDriver, {
  planMode: 'current-note',
  planner: prematurePlanner.driver,
  onToolEvent: (event) => prematurePlannerEvents.push(event),
}));
assert.equal(prematurePlannerResult.completeness, 'not-found', 'Planner must accept the first model answer even before search');
assert.equal(prematurePlannerResult.answer, '证据不足。');
assert.equal(prematurePlannerResult.evidence.length, 0);
assert.equal(prematurePlannerEvents.length, 0, 'zero-search answer must not trigger controller-owned recovery');
assert.ok(prematurePlannerResult.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

const multiGoalMarkdown = `# NER\n\n## 定义\n\nNER 是 Named Entity Recognition（命名实体识别），用于从文本中识别人名、地点和组织等实体。\n\n## 规则实现\n\n内置规则识别适合稳定格式，可通过词典和模式匹配抽取实体。\n\n## 模型实现\n\nspaCy 与 Transformers NER 可以处理更复杂的上下文，外部配置用于选择模型。\n\n## 附录\n\n${Array.from({ length: 250 }, (_, index) => `背景资料 ${index + 1}：这里不包含实现方式关键词。`).join('\n')}`;
const multiGoalLines = multiGoalMarkdown.split('\n');
const multiGoalSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/ner-plan-fallback.md',
  title: 'NER 多目标模型输出夹具',
  contentHash: createHash('sha256').update(multiGoalMarkdown, 'utf8').digest('hex'),
  markdown: multiGoalMarkdown,
  headings: [
    { id: 'ner-root', level: 1, text: 'NER', line: 1 },
    { id: 'ner-definition', level: 2, text: '定义', line: multiGoalLines.indexOf('## 定义') + 1 },
    { id: 'ner-rules', level: 2, text: '规则实现', line: multiGoalLines.indexOf('## 规则实现') + 1 },
    { id: 'ner-models', level: 2, text: '模型实现', line: multiGoalLines.indexOf('## 模型实现') + 1 },
    { id: 'ner-appendix', level: 2, text: '附录', line: multiGoalLines.indexOf('## 附录') + 1 },
  ],
  revision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
});
const multiGoalFallbackPlanner = createPlanner({
  goals: [
    {
      question: '笔记如何定义 NER？',
      evidenceKind: 'definition',
      requirements: [{ requirementId: 'r-ner-definition', label: 'NER 定义原文。', minEvidence: 1 }],
      queryTerms: ['NER', '命名实体识别'],
    },
    {
      question: '笔记列出了哪些 NER 实现方式？',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'r-ner-methods', label: '至少两条实现方式原文。', minEvidence: 2 }],
      queryTerms: ['内置规则识别', 'spaCy', 'Transformers NER', '外部配置'],
    },
  ],
});
const multiGoalFallbackTraces = [];
let multiGoalInvalidDecisions = 0;
const multiGoalFallbackResult = await runCurrentNoteAgent(agentInput({
  async decide() {
    multiGoalInvalidDecisions += 1;
    throw new SyntaxError('invalid JSON fixture');
  },
  async synthesize({ prompt }) {
    const citations = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
    return { type: 'answer', answer: 'NER 是命名实体识别，笔记同时给出了规则实现与模型实现。', citations, completeness: 'complete' };
  },
}, {
  snapshot: multiGoalSnapshot,
  question: 'NER 是什么？请结合笔记说明实现方式。',
  planMode: 'current-note',
  planner: multiGoalFallbackPlanner.driver,
  onDetailedTrace: (entry) => multiGoalFallbackTraces.push(entry),
}));
const multiGoalFallbackSearches = multiGoalFallbackTraces.filter((entry) =>
  entry.stage === 'react-tool'
  && entry.action === 'search_note'
  && entry.status === 'started'
  && entry.input?.fallbackMode === 'plan-coverage');
const multiGoalFallbackReads = multiGoalFallbackTraces.filter((entry) =>
  entry.stage === 'react-tool'
  && entry.action === 'read_note_range'
  && entry.status === 'completed'
  && entry.input?.fallbackMode === 'plan-coverage');
assert.equal(multiGoalInvalidDecisions, DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxInvalidActions, '连续无效动作必须在既有上限内停止。');
assert.equal(multiGoalFallbackSearches.length, 0, '模型动作失败后不得由控制器偷偷执行 Planner 查询词');
assert.equal(multiGoalFallbackReads.length, 0, '模型动作失败后不得由控制器自动读取原文');
assert.equal(multiGoalFallbackResult.evidence.length, 0, '最终模型回答不要求控制器补造引用');
assert.equal(multiGoalFallbackResult.completeness, 'complete');
assert.equal(multiGoalFallbackResult.answer, 'NER 是命名实体识别，笔记同时给出了规则实现与模型实现。');
assert.equal(multiGoalFallbackResult.searchPlan?.status, 'partial', '没有模型 planPatch 时 SearchPlan 只保留诊断状态，不得拦截答案');
assert.ok(multiGoalFallbackResult.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

const commitCoveragePlanner = createPlanner({
  scope: {
    mode: 'focused',
    coveragePolicy: 'sufficient',
    targetTopic: 'NER 实现方式',
    targetAspects: ['内置规则识别', '模型实现'],
  },
  goals: [{
    question: '笔记列出了哪些 NER 实现方式？',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'r-ner-methods', label: '至少两条独立实现方式原文。', minEvidence: 2 }],
    queryTerms: ['内置规则识别', 'spaCy', 'Transformers NER', '外部配置'],
  }],
});
const commitCoverageTraces = [];
let commitCoverageDecisions = 0;
let commitCoverageSynthesisCalls = 0;
const commitCoverageResult = await runCurrentNoteAgent(agentInput({
  async decide({ prompt }) {
    commitCoverageDecisions += 1;
    const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
    if (commitCoverageDecisions === 1) {
      return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['内置规则识别', 'spaCy', 'Transformers NER', '外部配置'] }, publicRationale: '先按计划关键词定位 NER 实现原文。' };
    }
    if (commitCoverageDecisions === 2) {
      return { type: 'tool', goalId, tool: 'read_note_section', arguments: { headingId: 'ner-rules' }, publicRationale: '先读取一段 NER 实现原文。' };
    }
    const requirementId = prompt.match(/req=([^\s,]+):/u)?.[1];
    const planVersion = Number(prompt.match(/planVersion=(\d+)/u)?.[1]);
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return {
      type: 'answer',
      answer: '模型过早使用一条证据提交完整答案。',
      citations: evidenceId ? [evidenceId] : [],
      completeness: 'complete',
      planPatch: {
        baseVersion: planVersion,
        activeGoalId: null,
        goalUpdates: [{
          goalId,
          status: 'covered',
          evidenceBindings: [{ requirementId, evidenceIds: evidenceId ? [evidenceId] : [] }],
        }],
      },
    };
  },
  async synthesize({ prompt }) {
    commitCoverageSynthesisCalls += 1;
    assert.match(prompt, /主进程已补读满足计划门槛的原文/u);
    const citations = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
    return { type: 'answer', answer: '主进程补读后，已根据多条原文生成完整答案。', citations, completeness: 'complete' };
  },
}, {
  snapshot: multiGoalSnapshot,
  question: 'NER 都有什么？结合笔记分析。',
  planMode: 'current-note',
  planner: commitCoveragePlanner.driver,
  memoryScopeKey: 'window-1:commit-coverage-recovery',
  onDetailedTrace: (entry) => commitCoverageTraces.push(entry),
}));
assert.equal(commitCoverageDecisions, 3, '首个 answer 必须直接终止 ReAct。');
assert.equal(commitCoverageSynthesisCalls, 0, '计划覆盖不足不得触发控制器补读后合成。');
assert.equal(commitCoverageResult.completeness, 'complete');
assert.equal(commitCoverageResult.answer, '模型过早使用一条证据提交完整答案。');
assert.equal(commitCoverageResult.agentStats.stopReason, 'answered');
assert.equal(commitCoverageResult.evidence.length, 1);
assert.equal(commitCoverageResult.searchPlan?.status, 'partial', '无效 planPatch 只能影响 SearchPlan 投影，不能改写答案。');
assert.ok(commitCoverageTraces.some((entry) => entry.action === 'mirror-model-answer-to-plan'
  && entry.status === 'completed'
  && entry.output?.ignoredPlanPatchCode === 'insufficient-evidence'));

const searchedBeforeAnswerEvents = [];
const searchedBeforeAnswerPlanner = createPlanner();
let searchedBeforeAnswerDecisions = 0;
const searchedBeforeAnswerDriver = {
  async decide({ prompt }) {
    searchedBeforeAnswerDecisions += 1;
    if (searchedBeforeAnswerDecisions === 1) {
      const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
      return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '先定位尾部原文。' };
    }
    return { type: 'answer', answer: '未读取原文，不能形成结论。', citations: [], completeness: 'not-found' };
  },
  async synthesize() { throw new Error('a prior search must not trigger a second automatic recovery'); },
};
const searchedBeforeAnswer = await runCurrentNoteAgent(agentInput(searchedBeforeAnswerDriver, {
  planMode: 'current-note',
  planner: searchedBeforeAnswerPlanner.driver,
  onToolEvent: (event) => searchedBeforeAnswerEvents.push(event),
}));
assert.equal(searchedBeforeAnswer.completeness, 'not-found');
assert.equal(searchedBeforeAnswerEvents.filter((event) => event.tool === 'search_note' && event.state === 'started').length, 1, 'an attempted search must prevent duplicate automatic recovery');
assert.equal(searchedBeforeAnswerEvents.filter((event) => event.tool === 'read_note_range').length, 0);

const noHitRecoveryEvents = [];
const noHitPlanner = createPlanner({
  goals: [{
    question: '核实不存在的术语。',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'r-missing', label: '必须有一条原文证据。', minEvidence: 1 }],
    queryTerms: ['unfindable_token_zz'],
  }],
});
const noHitRecoveryDriver = {
  async decide() { return { type: 'answer', answer: '未找到原文。', citations: [], completeness: 'not-found' }; },
  async synthesize() { throw new Error('an empty recovery search must keep the original not-found answer'); },
};
const noHitRecovery = await runCurrentNoteAgent(agentInput(noHitRecoveryDriver, {
  question: 'unfindable_token_zz 是什么？',
  planMode: 'current-note',
  planner: noHitPlanner.driver,
  onToolEvent: (event) => noHitRecoveryEvents.push(event),
}));
assert.equal(noHitRecovery.completeness, 'not-found');
assert.equal(noHitRecoveryEvents.filter((event) => event.tool === 'search_note' && event.state === 'started').length, 0);
assert.equal(noHitRecoveryEvents.filter((event) => event.tool === 'read_note_range').length, 0);

const exhaustedRecoveryEvents = [];
const exhaustedRecoveryPlanner = createPlanner();
const exhaustedRecovery = await runCurrentNoteAgent(agentInput(noHitRecoveryDriver, {
  planMode: 'current-note',
  planner: exhaustedRecoveryPlanner.driver,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxToolCalls: 0 },
  onToolEvent: (event) => exhaustedRecoveryEvents.push(event),
}));
assert.equal(exhaustedRecovery.completeness, 'not-found', 'model not-found is authoritative even when no tool budget remains');
assert.equal(exhaustedRecoveryEvents.filter((event) => event.tool === 'search_note').length, 0, 'no tool budget must prevent automatic recovery');

const offPlanner = createPlanner();
const offDriver = createEvidenceDriver();
const off = await runCurrentNoteAgent(agentInput(offDriver, { planMode: 'off', planner: offPlanner.driver }));
assert.equal(offPlanner.calls, 0, 'off mode keeps the old ReAct path.');
assert.equal(off.agentStats.decisionRounds, 3);

const invalidPlanner = createPlanner({ goals: Array.from({ length: 5 }, (_, index) => ({
  question: `目标 ${index + 1}`,
  evidenceKind: 'fact',
  requirements: [{ requirementId: `r-${index + 1}`, label: `证据 ${index + 1}`, minEvidence: 1 }],
  queryTerms: [`目标${index + 1}`],
})) });
const invalidDriver = createEvidenceDriver();
const invalid = await runCurrentNoteAgent(agentInput(invalidDriver, { planMode: 'current-note', planner: invalidPlanner.driver }));
assert.equal(invalidPlanner.calls, 2, 'Planner schema failure receives exactly one bounded repair call.');
assert.equal(invalid.searchPlan?.goals.length, 1, 'Repeated schema failure creates one local fallback goal.');
assert.ok(invalid.searchPlan?.goals[0].queryTerms.length <= 6);
assert.equal(invalid.agentStats.modelCalls, 5);
assert.ok(invalid.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

const malformedPlanner = createPlanner(null);
const malformedDriver = createEvidenceDriver();
const malformed = await runCurrentNoteAgent(agentInput(malformedDriver, { planMode: 'current-note', planner: malformedPlanner.driver }));
assert.equal(malformedPlanner.calls, 2);
assert.equal(malformed.searchPlan?.goals.length, 1);

const oneCallPlanner = createPlanner();
let oneCallDecisions = 0;
const oneCallDriver = {
  async decide() { oneCallDecisions += 1; throw new Error('decide must not run when only synthesis remains'); },
  async synthesize() { return { type: 'answer', answer: '直接合成。', citations: [], completeness: 'not-found' }; },
};
const oneCall = await runCurrentNoteAgent(agentInput(oneCallDriver, {
  planMode: 'current-note',
  planner: oneCallPlanner.driver,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxModelCalls: 1 },
}));
assert.equal(oneCallPlanner.calls, 0, 'With one remaining model call, Planner is skipped.');
assert.equal(oneCallDecisions, 0);
assert.equal(oneCall.agentStats.modelCalls, 1);
assert.equal(oneCall.searchPlan?.goals.length, 1, 'The no-Planner branch still has a local legal plan.');

const twoCallPlanner = createPlanner();
let twoCallDecisions = 0;
const twoCallDriver = {
  async decide() { twoCallDecisions += 1; throw new Error('decide must not run after Planner leaves only synthesis'); },
  async synthesize() { return { type: 'answer', answer: 'Planner 后直接合成。', citations: [], completeness: 'not-found' }; },
};
const twoCall = await runCurrentNoteAgent(agentInput(twoCallDriver, {
  planMode: 'current-note',
  planner: twoCallPlanner.driver,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxModelCalls: 2 },
}));
assert.equal(twoCallPlanner.calls, 1);
assert.equal(twoCallDecisions, 0);
assert.equal(twoCall.agentStats.modelCalls, 2);

const memory = new NoteConversationMemory();
const memoryPlanner = createPlanner();
await runCurrentNoteAgent(agentInput(createEvidenceDriver(), {
  planMode: 'current-note',
  planner: memoryPlanner.driver,
  memory,
}));
const reusedPlanner = createPlanner(undefined, () => { throw new Error('memory-reuse must not call Planner'); });
const reused = await runCurrentNoteAgent(agentInput({
  async decide() { throw new Error('memory-reuse must not decide'); },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '复用已验证证据。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
}, { planMode: 'current-note', planner: reusedPlanner.driver, memory }));
assert.equal(reused.contextMode, 'memory-reuse');
assert.equal(reusedPlanner.calls, 0);

const capsule = {
  schemaVersion: 1,
  title: '稳定 Capsule',
  contentHash,
  lineCount: snapshot.lineCount,
  headings: [{ id: 'tail', path: ['尾部证据'], lineFrom: tailHeadingLine, lineTo: snapshot.lineCount }],
  tags: [],
  wikiLinks: [],
  topTerms: ['尾部结论'],
  structuralStats: {},
};
const pathProbe = createPlanner();
await pathProbe.driver.plan({
  capsule,
  question: 'C:\\Users\\Eleven\\secret\\note.md 中尾部结论是什么？',
  conversation: [{ role: 'user', content: '请记住 D:/Private/hidden.md 不要泄露。' }],
  signal: new AbortController().signal,
});
assert.equal(pathProbe.calls, 1);
assert.doesNotMatch(pathProbe.prompts[0], /C:\\Users\\Eleven\\secret/u);
assert.doesNotMatch(pathProbe.prompts[0], /D:\/Private\/hidden/u);
assert.match(createCurrentNotePlanPrompt({ capsule, question: '尾部结论？', conversation: [], signal: new AbortController().signal }), /Note Capsule/);

const semanticAnchorPlanner = createPlanner({
  goals: [{
    question: '说明 NER。',
    evidenceKind: 'definition',
    requirements: [{ requirementId: 'r-ner', label: 'NER 定义原文。', minEvidence: 1 }],
    queryTerms: ['NER', '分析', '当前笔记'],
  }],
});
const semanticAnchorPlan = await semanticAnchorPlanner.driver.plan({
  capsule,
  question: '请你基于当前笔记帮我分析 NER 是什么？',
  conversation: [],
  signal: new AbortController().signal,
});
assert.deepEqual(
  semanticAnchorPlan.plan.goals[0]?.queryTerms.map((term) => term.term),
  ['ner'],
  'Planner QueryTerm 必须剔除分析、当前笔记等问题话术，只保留语义锚点。',
);

const cancelController = new AbortController();
let cancelPlannerCalls = 0;
let cancelDecisions = 0;
const cancelPlanner = createPlanner(validPlannerOutput, () => {
  cancelPlannerCalls += 1;
  cancelController.abort();
});
await assert.rejects(
  () => runCurrentNoteAgent(agentInput({
    async decide() { cancelDecisions += 1; throw new Error('cancelled flow must stop before decide'); },
    async synthesize() { throw new Error('cancelled flow must not synthesize'); },
  }, { planMode: 'current-note', planner: cancelPlanner.driver, signal: cancelController.signal })),
  /取消/,
);
assert.equal(cancelPlannerCalls, 1);
assert.equal(cancelDecisions, 0);

let stale = false;
const stalePlanner = createPlanner(validPlannerOutput, () => { stale = true; });
let staleDecisions = 0;
const staleResult = await runCurrentNoteAgent(agentInput({
  async decide() { staleDecisions += 1; throw new Error('stale flow must stop before decide'); },
  async synthesize() { throw new Error('stale flow must not synthesize'); },
}, {
  planMode: 'current-note',
  planner: stalePlanner.driver,
  isSnapshotCurrent: () => !stale,
}));
assert.equal(staleResult.agentStats.stopReason, 'snapshot-stale');
assert.equal(staleDecisions, 0);
assert.equal(stalePlanner.calls, 1);

const emptyFallback = createFallbackCurrentNotePlan('？！');
assert.equal(emptyFallback, undefined, 'An empty local tokenization must not create an empty plan.');
assert.deepEqual(
  deriveCurrentNoteFallbackQueryTerms('请你基于当前笔记，告诉我NER是什么'),
  ['ner'],
  '降级检索词必须保留模型问题中的技术锚点，不能泄漏索引分词的中文单字。',
);
assert.deepEqual(
  deriveCurrentNoteFallbackQueryTerms('请基于当前笔记解释缓存策略是什么'),
  ['缓存策略'],
  '没有英文缩写时，降级检索词必须保留完整中文主题，而不是字符切片。',
);
assert.deepEqual(
  deriveCurrentNoteFallbackQueryTerms('阅读笔记分析啥是NER？'),
  ['ner'],
  'Planner 降级时必须剔除阅读、分析和啥是等问法，只保留技术锚点。',
);
assert.deepEqual(
  deriveCurrentNoteFallbackQueryTerms('NER是啥？结合笔记分析'),
  ['ner'],
  '“结合笔记分析”是问题话术，不能成为固定词法兜底的检索词。',
);
const politeFallback = createFallbackCurrentNotePlan('请你基于当前笔记，告诉我NER是什么');
assert.deepEqual(
  politeFallback?.goals[0]?.queryTerms.map((term) => term.term),
  ['ner'],
  'fallback SearchPlan 的 QueryTerm 必须来自语义锚点提取，而不是索引 tokenizer。',
);
assert.match(
  createCurrentNotePlanPrompt({ capsule: { title: '夹具', contentHash: 'a'.repeat(64), lineCount: 1, headings: [], topTerms: [], tags: [], wikiLinks: [] }, question: 'NER是什么？', conversation: [], signal: new AbortController().signal }),
  /语义检索锚点/u,
  'Planner 提示必须要求模型抽取检索锚点。',
);
assert.match(
  createCurrentNotePlanPrompt({ capsule: { title: '夹具', contentHash: 'a'.repeat(64), lineCount: 1, headings: [], topTerms: [], tags: [], wikiLinks: [] }, question: 'NER 有哪些类型？', conversation: [], signal: new AbortController().signal }),
  /不要用 minEvidence 表示同一章节内列举项的数量/u,
  'Planner 不得把同一章节内的列举项数量误当成独立证据门槛。',
);

const mainSource = await fs.readFile(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
assert.match(mainSource, /if \(interactionRoute === 'chat'\)/u);
assert.match(mainSource, /const currentNoteSummaryMode/u);
assert.match(mainSource, /if \(currentNoteSummaryMode && currentNoteSnapshot\)/u);
assert.match(mainSource, /const useCurrentNotePlanner = shouldUseCurrentNotePlanner/u);
assert.match(mainSource, /hasExternalContext: Boolean\(request\.contextSources\?\.length \|\| request\.attachments\?\.length\)/u);

console.log('Current-note Plan-and-Execute P3 verification passed');
