import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-scope-routing');
const scopeFile = path.join(outDir, 'scope.cjs');
const driverFile = path.join(outDir, 'driver.cjs');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const shadowFile = path.join(outDir, 'shadow.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSearchScope.ts')], outfile: scopeFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: driverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantShadowPlan.ts')], outfile: shadowFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const scope = await import(pathToFileURL(scopeFile).href);
const driverModule = await import(pathToFileURL(driverFile).href);
const graph = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { runShadowPlan } = await import(pathToFileURL(shadowFile).href);

const fallback = scope.createFallbackCurrentNoteSearchScope;
const resolve = scope.resolveCurrentNoteSearchScope;

const focused = fallback('NER 模型的分类有哪些？');
assert.deepEqual({ mode: focused.mode, coveragePolicy: focused.coveragePolicy }, { mode: 'focused', coveragePolicy: 'sufficient' });
assert.equal(focused.targetTopic, 'NER');
assert.deepEqual(focused.targetAspects, ['模型分类']);

const broad = fallback('笔记里关于 NER 都讲了什么？');
assert.deepEqual({ mode: broad.mode, coveragePolicy: broad.coveragePolicy }, { mode: 'topic-wide', coveragePolicy: 'aspect-complete' });
const occurrences = fallback('逐处列出全文所有提到 NER 的地方。');
assert.deepEqual({ mode: occurrences.mode, coveragePolicy: occurrences.coveragePolicy }, { mode: 'topic-wide', coveragePolicy: 'occurrence-complete' });
assert.equal(scope.isWholeNoteSummaryWording('完整总结当前笔记'), true, '整篇总结仍由 structured-summary 路由处理。');
assert.deepEqual({ mode: fallback('完整总结当前笔记').mode, coveragePolicy: fallback('完整总结当前笔记').coveragePolicy }, { mode: 'focused', coveragePolicy: 'sufficient' });
const focusedExplicit = resolve('只看 NER 模型分类这一节', {
  mode: 'topic-wide',
  coveragePolicy: 'aspect-complete',
  targetTopic: 'NER',
  targetAspects: ['模型分类'],
});
assert.equal(focusedExplicit.mode, 'focused', '显式用户范围必须覆盖 Planner 推断。');
assert.equal(focusedExplicit.coveragePolicy, 'sufficient');
assert.equal(focusedExplicit.origin, 'user-explicit');

const validOutput = {
  scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: 'NER', targetAspects: ['模型分类', '评估'] },
  goals: [{
    question: '核实 NER 的模型分类和评估。',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'r1', label: '模型分类与评估有原文依据。', minEvidence: 1 }],
    queryTerms: ['NER', '模型分类'],
  }],
};
let calls = 0;
const planner = driverModule.createCurrentNotePlanDriver({
  async generateJson() {
    calls += 1;
    return validOutput;
  },
});
const capsule = { schemaVersion: 1, title: '夹具', contentHash: 'a'.repeat(64), lineCount: 3, headings: [], tags: [], wikiLinks: [], topTerms: ['NER'], structuralStats: {} };
const planResult = await planner.plan({ capsule, question: 'NER 模型分类和评估有哪些？', conversation: [], signal: new AbortController().signal });
assert.equal(calls, 1, '范围随现有 Planner 一次返回，不增加模型调用。');
assert.equal(planResult.scope.mode, 'topic-wide');
assert.equal(planResult.scope.coveragePolicy, 'aspect-complete');
assert.equal(planResult.plan.goals.length, 1);

const invalidValues = [
  { scope: { mode: 'focused', coveragePolicy: 'sufficient', extra: true }, goals: validOutput.goals },
  { scope: { mode: 'unknown', coveragePolicy: 'sufficient' }, goals: validOutput.goals },
  { scope: { mode: 'focused', coveragePolicy: 'aspect-complete' }, goals: validOutput.goals },
  { scope: { mode: 'topic-wide', coveragePolicy: 'occurrence-complete' }, goals: validOutput.goals },
  { scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: 'x'.repeat(81) }, goals: validOutput.goals },
  { scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetAspects: Array.from({ length: 7 }, () => '方面') }, goals: validOutput.goals },
  { scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetAspects: ['x'] }, goals: validOutput.goals },
  { scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetAspects: ['x'.repeat(81)] }, goals: validOutput.goals },
];
// Run each invalid case with a fresh one-shot driver so its output is controlled.
for (const invalid of invalidValues) {
  const invalidDriver = driverModule.createCurrentNotePlanDriver({ async generateJson() { return invalid; } });
  await assert.rejects(() => invalidDriver.plan({ capsule, question: 'NER 是什么？', conversation: [], signal: new AbortController().signal }));
}

const markdown = '# NER\n\nNER 模型分类见此处。';
const snapshot = createCurrentNoteSnapshot({ libraryPath: 'C:/Notes', notePath: 'C:/Notes/ner.md', title: 'NER', contentHash: createHash('sha256').update(markdown).digest('hex'), markdown, headings: [{ id: 'ner', level: 1, text: 'NER', line: 1 }], revision: 1, createdAt: '2026-08-22T00:00:00.000Z' });
const agentDriver = driverModule.createCurrentNotePlanDriver({ async generateJson() { return { scope: { mode: 'focused', coveragePolicy: 'sufficient', extra: 'reject' }, goals: validOutput.goals }; } });
const simpleActionDriver = {
  async decide() { return { type: 'answer', answer: '未找到。', citations: [], completeness: 'not-found' }; },
  async synthesize() { return { type: 'answer', answer: '未找到。', citations: [], completeness: 'not-found' }; },
};
const agentResult = await graph.runCurrentNoteAgent({
  snapshot,
  question: 'NER 是什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  signal: new AbortController().signal,
  driver: simpleActionDriver,
  planner: agentDriver,
  planMode: 'current-note',
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'scope-routing',
  isSnapshotCurrent: () => true,
});
assert.equal(agentResult.searchPlan?.goals.length, 1, '无效 Planner 输出必须回退到本地合法计划。');
assert.equal(agentResult.searchScope?.mode, 'focused');
assert.equal(agentResult.searchScope?.origin, 'controller-fallback');
assert.equal(driverModule.shouldUseCurrentNotePlanner({ planMode: 'off', interactionRoute: 'react', contextMode: 'react-search', hasExternalContext: false }), false, 'assistantPlanMode=off 保持旧路径。');

let shadowCalls = 0;
const shadowResult = await runShadowPlan({
  question: '笔记里关于 NER 都讲了什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  coordinator: { prepare: () => ({ ready: true, call: { plan: { maxOutputTokens: 256, predictedPromptTokens: 42 } } }) },
  signal: new AbortController().signal,
  isSnapshotCurrent: () => true,
  legacyScope: fallback('NER 是什么？'),
  generateJson: async () => {
    shadowCalls += 1;
    return { scope: { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: 'NER', targetAspects: [] }, goals: validOutput.goals };
  },
});
assert.equal(shadowCalls, 1, 'shadow-plan 只使用一次既有 Planner 调用。');
assert.equal(shadowResult.status, 'ran');
assert.equal(shadowResult.scopeComparison?.previous.mode, 'focused');
assert.equal(shadowResult.scopeComparison?.proposed.mode, 'topic-wide');
assert.equal(shadowResult.scopeComparison?.changed, true, 'shadow-plan 记录旧/新范围但不改变旧答案。');

console.log('Current-note scope routing verification passed');
