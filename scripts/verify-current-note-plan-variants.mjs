import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-plan-variants');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const validationFile = path.join(outDir, 'validation.cjs');
const lexicalFile = path.join(outDir, 'lexical-index.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanValidation.ts')], outfile: validationFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')], outfile: lexicalFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { runCurrentNoteAgent } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { applySearchPlanPatch, createSearchPlan } = await import(pathToFileURL(validationFile).href);
const { CurrentNoteLexicalIndex } = await import(pathToFileURL(lexicalFile).href);

function makeSnapshot(sections, suffix = '') {
  const filler = Array.from({ length: 220 }, (_, index) => `阶段 5 背景 ${index + 1}：仅用于确保当前笔记走 react-search。`).join('\n');
  const markdown = `# 阶段 5 词法变体夹具\n\n${filler}\n\n${sections.map(({ heading, body }) => `## ${heading}\n\n${body}`).join('\n\n')}${suffix}`;
  const lines = markdown.split('\n');
  const headings = [
    { id: 'root', level: 1, text: '阶段 5 词法变体夹具', line: 1 },
    ...sections.map(({ heading, id }, index) => ({ id: id ?? `section-${index + 1}`, level: 2, text: heading, line: lines.indexOf(`## ${heading}`) + 1 })),
  ];
  return createCurrentNoteSnapshot({
    libraryPath: 'C:/Notes',
    notePath: `C:/Notes/stage5-${sections.map(({ heading }) => heading).join('-')}.md`,
    title: '阶段 5 词法变体夹具',
    contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    markdown,
    headings,
    revision: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
  });
}

function contextOf(prompt) {
  return {
    goalId: prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1],
    version: Number(prompt.match(/planVersion=(\d+)/u)?.[1]),
    requirementId: prompt.match(/req=([^\s,]+):/u)?.[1],
    evidenceId: prompt.match(/evidence-[a-f0-9]{24}/u)?.[0],
  };
}

function makePlanner(output) {
  let calls = 0;
  const driver = createCurrentNotePlanDriver({
    async generateJson() {
      calls += 1;
      return output;
    },
  });
  return { driver, get calls() { return calls; } };
}

function makeDriver(decide) {
  let decisions = 0;
  const actions = [];
  return {
    get decisions() { return decisions; },
    actions,
    async decide({ prompt }) {
      decisions += 1;
      try {
        const action = decide(decisions, prompt);
        actions.push(action);
        return action;
      } catch (error) {
        actions.push({ type: 'driver-error', message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    async synthesize({ prompt }) {
      const context = contextOf(prompt);
      return { type: 'answer', answer: '合成结果。', citations: context.evidenceId ? [context.evidenceId] : [], completeness: 'partial' };
    },
  };
}

function tool(prompt, toolName, argumentsValue, planPatch) {
  const context = contextOf(prompt);
  return {
    type: 'tool',
    goalId: context.goalId,
    tool: toolName,
    arguments: argumentsValue,
    publicRationale: `阶段 5：${toolName}`,
    ...(planPatch ? { planPatch } : {}),
  };
}

function finalAnswer(prompt, completeness = 'complete', planPatch) {
  const context = contextOf(prompt);
  return {
    type: 'answer',
    answer: '根据当前笔记原文形成回答。',
    citations: context.evidenceId ? [context.evidenceId] : [],
    completeness,
    ...(planPatch ? { planPatch } : {}),
  };
}

function inputFor(snapshot, question, planner, driver, suffix) {
  const lineFrom = snapshot.headings.find((heading) => heading.level === 2)?.lineFrom ?? 1;
  const events = [];
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
    memoryScopeKey: `stage5:${suffix}`,
    isSnapshotCurrent: () => true,
    lineFrom,
    events,
    onToolEvent: (event) => events.push(event),
  };
}

function factPlan(goalId, requirementId, term) {
  return { goals: [{
    goalId,
    question: `核实 ${term}`,
    evidenceKind: 'fact',
    requirements: [{ requirementId, label: `原文证明 ${term}`, minEvidence: 1 }],
    queryTerms: [term],
  }] };
}

function coveredPatch(prompt, goalId) {
  const context = contextOf(prompt);
  return {
    baseVersion: context.version,
    activeGoalId: null,
    goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId: context.requirementId, evidenceIds: [context.evidenceId] }] }],
  };
}

function runExactFlow(snapshot, question, planner, term, suffix) {
  const lineFrom = snapshot.headings.find((heading) => heading.level === 2)?.lineFrom ?? 1;
  const driver = makeDriver((count, prompt) => {
    if (count === 1) return tool(prompt, 'search_note', { terms: [term] });
    if (count === 2) return tool(prompt, 'read_note_range', { lineFrom, lineTo: lineFrom + 2 });
    return finalAnswer(prompt, 'complete', coveredPatch(prompt, 'goal-term'));
  });
  return { driver, input: inputFor(snapshot, question, planner, driver, suffix) };
}

const exactSnapshot = makeSnapshot([
  { id: 'ner', heading: 'NER', body: 'NER 是当前夹具中的命名实体识别标识。' },
  { id: 'springboot', heading: 'SpringBoot', body: 'SpringBoot 是当前夹具中的技术标识。' },
]);

// NER and Ner are exact local matches; no model query variant or revision is needed.
for (const [question, term, suffix] of [['NER 是什么？', 'NER', 'ner-upper'], ['Ner 是什么？', 'Ner', 'ner-mixed']]) {
  const planner = makePlanner(factPlan('goal-term', 'req-term', term));
  const flow = runExactFlow(exactSnapshot, question, planner, term, suffix);
  const result = await runCurrentNoteAgent(flow.input);
  assert.equal(planner.calls, 1);
  assert.equal(result.completeness, 'complete', JSON.stringify({ answer: result.answer, plan: result.searchPlan, stats: result.agentStats, actions: flow.driver.actions, events: flow.input.events }));
  assert.equal(result.searchPlan?.revisionCount, 0, `${term} must not trigger a model variant`);
  assert.deepEqual(result.searchPlan?.goals[0].queryTerms.map((queryTerm) => queryTerm.source), ['planner']);
}

// The existing local fuzzy policy resolves Spingboot -> SpringBoot; this is
// not a reason to ask the model for another spelling.
const fuzzyHits = new CurrentNoteLexicalIndex(exactSnapshot).search('Spingboot');
assert.ok(fuzzyHits.some((hit) => hit.matchTypes.includes('fuzzy')));
const fuzzyPlanner = makePlanner(factPlan('goal-term', 'req-term', 'Spingboot'));
const fuzzyFlow = runExactFlow(exactSnapshot, 'Spingboot 是什么？', fuzzyPlanner, 'Spingboot', 'spingboot');
const fuzzyResult = await runCurrentNoteAgent(fuzzyFlow.input);
assert.equal(fuzzyResult.completeness, 'complete');
assert.equal(fuzzyResult.searchPlan?.revisionCount, 0);
assert.deepEqual(fuzzyResult.searchPlan?.goals[0].queryTerms.map((queryTerm) => queryTerm.term), ['spingboot']);

// A zero-result NER query may add the Chinese full name as an explicit model
// synonym, then it still has to search and read the original text.
const chineseSnapshot = makeSnapshot([{ id: 'entity', heading: '命名实体识别', body: '命名实体识别用于抽取组织、人物和地点。' }]);
const chinesePlanner = makePlanner(factPlan('goal-ner-full', 'req-ner-full', 'NER'));
const chineseLine = chineseSnapshot.headings.find((heading) => heading.headingId === 'entity')?.lineFrom ?? 1;
const chineseDriver = makeDriver((count, prompt) => {
  const context = contextOf(prompt);
  if (count === 1) return tool(prompt, 'search_note', { terms: ['NER'] });
  if (count === 2) return tool(prompt, 'search_note', { terms: ['命名实体识别'] }, {
    baseVersion: context.version,
    activeGoalId: context.goalId,
    goalUpdates: [{ goalId: context.goalId, status: 'searching', queryVariants: [{ term: '命名实体识别', source: 'model-synonym' }] }],
  });
  if (count === 3) return tool(prompt, 'read_note_range', { lineFrom: chineseLine, lineTo: chineseLine + 2 });
  return finalAnswer(prompt, 'complete', coveredPatch(prompt, 'goal-ner-full'));
});
const chineseResult = await runCurrentNoteAgent(inputFor(chineseSnapshot, 'NER 的中文全称是什么？', chinesePlanner, chineseDriver, 'ner-full'));
assert.equal(chineseResult.completeness, 'complete');
assert.equal(chineseResult.searchPlan?.revisionCount, 1);
assert.deepEqual(chineseResult.searchPlan?.goals[0].queryTerms.map((queryTerm) => ({ term: queryTerm.term, source: queryTerm.source })), [
  { term: 'ner', source: 'planner' },
  { term: '命名实体识别', source: 'model-synonym' },
]);

// RBG -> RAG remains a model-synonym candidate in SearchPlan, but the model now
// owns the final answer and completeness without a post-answer evidence gate.
const ragSnapshot = makeSnapshot([{ id: 'rag', heading: 'RAG', body: 'RAG 在旧版配置中用于检索增强生成。' }]);
const ragPlanner = makePlanner(factPlan('goal-rbg', 'req-rbg', 'RBG'));
const ragLine = ragSnapshot.headings.find((heading) => heading.headingId === 'rag')?.lineFrom ?? 1;
const ragDriver = makeDriver((count, prompt) => {
  const context = contextOf(prompt);
  if (count === 1) return tool(prompt, 'search_note', { terms: ['RBG'] });
  if (count === 2) return tool(prompt, 'search_note', { terms: ['RAG'] }, {
    baseVersion: context.version,
    activeGoalId: context.goalId,
    goalUpdates: [{ goalId: context.goalId, status: 'searching', queryVariants: [{ term: 'RAG', source: 'model-synonym' }] }],
  });
  if (count === 3) return tool(prompt, 'read_note_range', { lineFrom: ragLine, lineTo: ragLine + 2 });
  return finalAnswer(prompt, 'complete', coveredPatch(prompt, 'goal-rbg'));
});
const ragResult = await runCurrentNoteAgent(inputFor(ragSnapshot, 'RBG 是什么？', ragPlanner, ragDriver, 'rbg-rag'));
assert.equal(ragResult.completeness, 'complete');
assert.equal(ragResult.searchPlan?.status, 'completed');
assert.doesNotMatch(ragResult.answer, /不确定|确认术语/u, JSON.stringify({ answer: ragResult.answer, plan: ragResult.searchPlan, stats: ragResult.agentStats, actions: ragDriver.actions }));
assert.equal(ragResult.searchPlan?.goals[0].queryTerms.at(-1)?.source, 'model-synonym');

// Controller scope proof is required for non-model sources.
const scopeBase = createSearchPlan({ originalQuestion: 'scope', goals: [{
  goalId: 'goal-scope', question: 'scope', evidenceKind: 'fact',
  requirements: [{ requirementId: 'req-scope', label: 'scope', minEvidence: 1 }], queryTerms: ['alpha'],
}] }, { planId: 'plan-scope', now: '2026-08-22T00:00:00.000Z' });
const scopeStarted = applySearchPlanPatch(scopeBase, { baseVersion: 1, goalUpdates: [{ goalId: 'goal-scope', status: 'searching' }] });
assert.equal(scopeStarted.ok, true);
const scopeRejected = applySearchPlanPatch(scopeStarted.plan, {
  baseVersion: scopeStarted.plan.version,
  goalUpdates: [{ goalId: 'goal-scope', status: 'searching', queryVariants: [{ term: 'beta', source: 'note-map' }] }],
}, { queryVariantScope: { noteMapTerms: ['gamma'] } });
assert.equal(scopeRejected.ok, false);
assert.equal(scopeRejected.code, 'query-variant-source-scope');
const scopeAccepted = applySearchPlanPatch(scopeStarted.plan, {
  baseVersion: scopeStarted.plan.version,
  goalUpdates: [{ goalId: 'goal-scope', status: 'searching', queryVariants: [{ term: 'beta', source: 'note-map' }] }],
}, { queryVariantScope: { noteMapTerms: ['beta'] } });
assert.equal(scopeAccepted.ok, true);

// Duplicate variants remain atomic, while cumulative QueryTerm count is no longer capped.
let budgetPlan = scopeStarted.plan;
budgetPlan = applySearchPlanPatch(budgetPlan, {
  baseVersion: budgetPlan.version,
  goalUpdates: [{ goalId: 'goal-scope', status: 'searching', queryVariants: [
    { term: 'beta', source: 'model-synonym' }, { term: 'gamma', source: 'model-synonym' },
  ] }],
}).plan;
const duplicateBefore = JSON.stringify(budgetPlan);
const duplicate = applySearchPlanPatch(budgetPlan, {
  baseVersion: budgetPlan.version,
  goalUpdates: [{ goalId: 'goal-scope', status: 'searching', queryVariants: [{ term: 'beta', source: 'model-synonym' }] }],
});
assert.equal(duplicate.ok, false);
assert.equal(duplicate.code, 'duplicate-query-variant');
assert.equal(JSON.stringify(budgetPlan), duplicateBefore);
budgetPlan = applySearchPlanPatch(budgetPlan, {
  baseVersion: budgetPlan.version,
  goalUpdates: [{ goalId: 'goal-scope', status: 'searching', queryVariants: [
    { term: 'delta', source: 'model-synonym' }, { term: 'epsilon', source: 'model-synonym' },
    { term: 'zeta', source: 'model-synonym' }, { term: 'eta', source: 'model-synonym' },
  ] }],
}).plan;
assert.equal(budgetPlan.goals[0].queryTerms.length, 7);

console.log('Current-note queryVariants P5 verification passed');
