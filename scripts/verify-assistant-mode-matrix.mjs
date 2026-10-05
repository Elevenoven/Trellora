import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const stagingDir = process.env.MENGHAN_ASSISTANT_MODE_MATRIX_PREBUILT_DIR
  ? path.resolve(process.env.MENGHAN_ASSISTANT_MODE_MATRIX_PREBUILT_DIR)
  : path.join(rootDir, '.package-staging', 'verify-assistant-mode-matrix');
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'library-plan-execute');

if (!process.env.MENGHAN_ASSISTANT_MODE_MATRIX_PREBUILT_DIR) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  await Promise.all([
    bundle('electron/knowledge/currentNoteAgentGraph.ts', 'current-note-graph.cjs'),
    bundle('electron/knowledge/currentNoteSnapshot.ts', 'current-note-snapshot.cjs'),
    bundle('electron/knowledge/searchPlanDriver.ts', 'search-plan-driver.cjs'),
    bundle('electron/knowledge/modelCallCoordinator.ts', 'model-call-coordinator.cjs'),
    bundle('electron/knowledge/modelCallBudget.ts', 'model-call-budget.cjs'),
    bundle('electron/knowledge/noteConversationMemory.ts', 'note-memory.cjs'),
    bundle('electron/knowledge/assistantShadowPlan.ts', 'assistant-shadow-plan.cjs'),
    bundle('electron/knowledge/assistantMode.ts', 'assistant-mode.cjs'),
    bundle('electron/knowledge/libraryPlanAgentGraph.ts', 'library-plan-graph.cjs'),
    bundle('electron/noteIndex.ts', 'note-index.cjs'),
    bundle('electron/appPreferences.ts', 'app-preferences.cjs'),
  ]);
}

const { runCurrentNoteAgent } = await import(pathToFileURL(path.join(stagingDir, 'current-note-graph.cjs')).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(path.join(stagingDir, 'current-note-snapshot.cjs')).href);
const { createFallbackCurrentNotePlan } = await import(pathToFileURL(path.join(stagingDir, 'search-plan-driver.cjs')).href);
const { ModelCallCoordinator } = await import(pathToFileURL(path.join(stagingDir, 'model-call-coordinator.cjs')).href);
const { ModelCallBudgetGate } = await import(pathToFileURL(path.join(stagingDir, 'model-call-budget.cjs')).href);
const { NoteConversationMemory } = await import(pathToFileURL(path.join(stagingDir, 'note-memory.cjs')).href);
const { runShadowPlan } = await import(pathToFileURL(path.join(stagingDir, 'assistant-shadow-plan.cjs')).href);
const { normalizeAssistantModeConfig, shouldUseCurrentNotePlanner, shouldUseLibraryPlanner } = await import(pathToFileURL(path.join(stagingDir, 'assistant-mode.cjs')).href);
const { normalizeAppPreferences } = await import(pathToFileURL(path.join(stagingDir, 'app-preferences.cjs')).href);
const { runLibraryPlanAgent, createLibraryNoteSnapshotMap } = await import(pathToFileURL(path.join(stagingDir, 'library-plan-graph.cjs')).href);
const { buildNoteIndex } = await import(pathToFileURL(path.join(stagingDir, 'note-index.cjs')).href);

const contextWindowTokens = 32_000;
const sampleCount = 30;
const markdown = [
  '# 受控检索夹具',
  '',
  '## 结论',
  '',
  '真实结论：原文证据必须先读取，才能形成完整回答。',
  '',
  '## 背景',
  '',
  '该夹具只验证同一调度器、模式边界和可重复的工具序列。',
  ...Array.from({ length: 260 }, (_, index) => `背景扩展内容 ${index + 1}，用于强制进入 react-search。`),
].join('\n');
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/fixture-library',
  notePath: 'C:/fixture-library/controlled.md',
  title: '受控检索夹具',
  contentHash,
  markdown,
  headings: [
    { id: 'root', level: 1, text: '受控检索夹具', line: 1 },
    { id: 'conclusion', level: 2, text: '结论', line: 3 },
    { id: 'background', level: 2, text: '背景', line: 7 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});

const expectedAnswer = '根据已读取的原文，证据必须先读取后回答。';

function createCurrentNoteFixture(mode) {
  const prompts = [];
  const toolEvents = [];
  const modelGate = new ModelCallBudgetGate({ maxModelCalls: 8, maxWallTimeMs: 60_000 });
  const coordinator = new ModelCallCoordinator(modelGate, contextWindowTokens, 'react-turn', undefined, { providerKind: 'ollama', model: 'fixture-model' });
  let decisions = 0;
  const planner = { plan: async ({ prompt }) => { prompts.push({ callKind: 'plan', prompt }); return createFallbackCurrentNotePlan('结论是什么？'); } };
  const driver = {
    async decide({ prompt }) {
      prompts.push({ callKind: 'decide', prompt });
      const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
      const planVersion = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
      decisions += 1;
      if (decisions === 1) return { type: 'tool', ...(goalId ? { goalId } : {}), tool: 'search_note', arguments: { terms: ['结论'], limit: 4 }, publicRationale: '定位结论原文。' };
      if (decisions === 2) return { type: 'tool', ...(goalId ? { goalId } : {}), tool: 'read_note_range', arguments: { lineFrom: 5, lineTo: 5 }, publicRationale: '读取结论原文。' };
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return {
        type: 'answer',
        answer: expectedAnswer,
        citations: evidenceId ? [evidenceId] : [],
        completeness: 'complete',
        ...(goalId && evidenceId ? {
          planPatch: {
            baseVersion: planVersion,
            activeGoalId: null,
            goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId: 'requirement-local-fallback', evidenceIds: [evidenceId] }] }],
          },
        } : {}),
      };
    },
    async synthesize({ prompt }) {
      prompts.push({ callKind: 'synthesize', prompt });
      return { type: 'answer', answer: expectedAnswer, citations: [], completeness: 'not-found' };
    },
  };
  const resultPromise = runCurrentNoteAgent({
    snapshot,
    question: '结论是什么？',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    contextWindowTokens,
    signal: new AbortController().signal,
    driver,
    memory: new NoteConversationMemory(),
    memoryScopeKey: `matrix-${mode}`,
    isSnapshotCurrent: () => true,
    onToolEvent: (event) => toolEvents.push(event),
    modelCallGate: modelGate,
    modelCallCoordinator: coordinator,
    ...(mode === 'current-note' ? { planMode: 'current-note', planner } : { planMode: mode === 'shadow-plan' ? 'shadow-plan' : 'off' }),
    adaptiveContextMode: mode === 'current-note' ? 'enforce' : 'observe',
  });
  return { resultPromise, prompts, toolEvents, coordinator, modelGate };
}

async function runCurrentMode(mode) {
  const fixture = createCurrentNoteFixture(mode);
  const result = await fixture.resultPromise;
  if (mode === 'current-note') {
    assert.equal(result.searchScope?.mode, 'focused');
    assert.ok(result.coverage?.discoveredHeadingCount >= result.coverage?.readHeadingCount);
  }
  if (mode === 'shadow-plan') assert.equal(result.searchScope, undefined, 'shadow-plan 不应把新范围投影到答案结果');
  let shadowPlan;
  if (mode === 'shadow-plan') {
    shadowPlan = await runShadowPlan({
      question: '结论是什么？',
      conversation: [],
      providerKind: 'ollama',
      model: 'fixture-model',
      coordinator: fixture.coordinator,
      signal: new AbortController().signal,
      isSnapshotCurrent: () => true,
      sourceSummaries: ['受控检索夹具：已读取原文。'],
      generateJson: async ({ prompt }) => { fixture.prompts.push({ callKind: 'shadow-plan', prompt }); return { goals: [] }; },
    });
  }
  const promptTokens = fixture.prompts.map((entry) => estimateFixtureTokens(entry.prompt));
  return {
    mode,
    answer: result.answer,
    toolSequence: fixture.toolEvents.filter((event) => event.state !== 'started').map((event) => `${event.tool}:${event.state}`),
    modelCalls: result.agentStats.modelCalls + (shadowPlan?.status === 'ran' ? 1 : 0),
    windowOccupancyTokens: Math.max(...promptTokens, shadowPlan?.promptTokens ?? 0),
    totalPromptTokens: promptTokens.reduce((sum, value) => sum + value, 0) + (shadowPlan?.promptTokens ?? 0),
    promptKinds: fixture.prompts.map((entry) => entry.callKind),
    promptStats: result.contextUsage.promptStats,
    shadowPlan,
  };
}

function estimateFixtureTokens(prompt) {
  let tokens = 0;
  let latin = 0;
  const flush = () => { tokens += latin ? Math.ceil(latin / 4) : 0; latin = 0; };
  for (const char of prompt) {
    if (/\s/u.test(char)) { flush(); continue; }
    if (/^[\u3400-\u9fff]$/u.test(char)) { flush(); tokens += 1; continue; }
    if (/[A-Za-z0-9]/u.test(char)) latin += 1;
    else { flush(); tokens += 1; }
  }
  flush();
  return tokens;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

const matrix = [
  normalizeAssistantModeConfig({ assistantPlanMode: 'off', adaptiveContextMode: 'enforce' }),
  normalizeAssistantModeConfig({ assistantPlanMode: 'shadow-plan', adaptiveContextMode: 'observe' }),
  normalizeAssistantModeConfig({ assistantPlanMode: 'current-note', adaptiveContextMode: 'enforce' }),
];
assert.deepEqual(matrix[0], { assistantPlanMode: 'off', adaptiveContextMode: 'observe' });
assert.equal(shouldUseCurrentNotePlanner('current-note'), true);
assert.equal(shouldUseCurrentNotePlanner('shadow-plan'), false);
assert.equal(shouldUseLibraryPlanner('current-note'), false);
assert.equal(shouldUseLibraryPlanner('library-beta'), true);
assert.equal(shouldUseLibraryPlanner('default'), true);
assert.equal(normalizeAppPreferences({ assistantPlanMode: 'default', adaptiveContextMode: 'enforce' }).assistantPlanMode, 'current-note');

const modes = ['off', 'shadow-plan', 'current-note'];
const report = [];
for (const mode of modes) {
  const samples = [];
  let first;
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    const current = await runCurrentMode(mode);
    const wallMs = performance.now() - startedAt;
    first ??= current;
    samples.push({ ...current, wallMs });
  }
  assert.equal(first.answer, expectedAnswer, `${mode} must keep the fixture answer stable`);
  if (mode === 'shadow-plan') {
    assert.deepEqual(first.toolSequence, report[0]?.toolSequence, 'shadow-plan must not change old tool sequence');
    assert.equal(first.shadowPlan?.status, 'ran');
  }
  report.push({
    mode,
    answer: first.answer,
    toolSequence: first.toolSequence,
    windowOccupancyTokens: first.windowOccupancyTokens,
    totalPromptTokens: first.totalPromptTokens,
    modelCalls: first.modelCalls,
    p95WallMs: percentile(samples.map((sample) => sample.wallMs), 0.95),
    promptStats: first.promptStats,
    promptKinds: first.promptKinds,
    shadowPlan: first.shadowPlan,
  });
}
assert.deepEqual(report[0].toolSequence, report[1].toolSequence);
assert.equal(report[0].answer, report[1].answer);
assert.ok(report[2].modelCalls > report[0].modelCalls, `formal current-note route must account for its Planner call: ${JSON.stringify(report.map((entry) => ({ mode: entry.mode, modelCalls: entry.modelCalls, answer: entry.answer, tools: entry.toolSequence, promptKinds: entry.promptKinds })))}`);

const libraryIndex = buildNoteIndex(fixtureDir);
const librarySessionId = 'matrix-library-session';
const librarySnapshotMap = createLibraryNoteSnapshotMap({ libraryPath: fixtureDir, index: libraryIndex, sessionId: librarySessionId, revision: 1, indexState: 'latest' });
const libraryRecords = [...librarySnapshotMap.records.values()];
const libraryGoalId = 'goal-library-matrix';
const libraryPlan = {
  planId: 'plan-library-matrix', version: 1, originalQuestion: '核实方案', activeGoalId: libraryGoalId, status: 'active', revisionCount: 0, goalUpdateCount: 0,
  createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
  goals: [{ goalId: libraryGoalId, question: '核实方案原文', evidenceKind: 'fact', requirements: [{ requirementId: 'req-library', label: '方案原文', minEvidence: 1 }], queryTerms: [{ term: '方案', source: 'planner' }], status: 'pending', evidenceBindings: [], conflictBindings: [] }],
};
let libraryStep = 0;
const libraryTools = [];
const libraryGate = new ModelCallBudgetGate({ maxModelCalls: 8, maxWallTimeMs: 60_000 });
const libraryCoordinator = new ModelCallCoordinator(libraryGate, contextWindowTokens, 'react-turn', undefined, { providerKind: 'ollama', model: 'fixture-model' });
const libraryResult = await runLibraryPlanAgent({
  snapshotMap: librarySnapshotMap,
  sessionId: librarySessionId,
  question: '核实方案',
  conversation: [],
  providerKind: 'ollama', model: 'fixture-model', contextWindowTokens,
  signal: new AbortController().signal,
  modelCallGate: libraryGate, modelCallCoordinator: libraryCoordinator, adaptiveContextMode: 'enforce',
  planner: { plan: async () => libraryPlan },
  driver: {
    async decide({ prompt }) {
      const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1] ?? libraryGoalId;
      const planVersion = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 1);
      libraryStep += 1;
      if (libraryStep === 1) return { type: 'tool', goalId, tool: 'search_note_library', arguments: { limit: 8 }, publicRationale: '定位候选笔记。' };
      if (libraryStep === 2) return { type: 'tool', goalId, tool: 'read_library_note_range', arguments: { noteId: libraryRecords[0].noteId, lineFrom: 5, lineTo: 5 }, publicRationale: '读取候选笔记原文。' };
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return { type: 'answer', answer: '已读取整库候选笔记的原文。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete', planPatch: { baseVersion: planVersion, activeGoalId: null, goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId: 'req-library', evidenceIds: evidenceId ? [evidenceId] : [] }] }] } };
    },
    async synthesize() { throw new Error('library fixture should answer in decide'); },
  },
  searchMode: 'keyword',
  search: {
    keywordSearch: () => libraryIndex.notes.map((note) => ({ path: note.path, title: note.title, score: 1, snippet: '候选摘要' })),
    semanticSearch: async () => [],
  },
  isSnapshotCurrent: () => true,
  onToolEvent: (event) => { if (event.state !== 'started') libraryTools.push(event.tool); },
});
assert.equal(libraryResult.completeness, 'complete');
assert.deepEqual(libraryTools.slice(0, 2), ['search_note_library', 'read_library_note_range']);
assert.equal(libraryResult.contextUsage.promptStats?.callKind, 'synthesize');

console.log(JSON.stringify({
  contextWindowTokens,
  sampleCount,
  modes: report,
  libraryBeta: {
    answer: libraryResult.answer,
    toolSequence: libraryTools,
    modelCalls: libraryResult.agentStats.modelCalls,
    windowOccupancyTokens: libraryResult.contextUsage.promptStats?.predictedPromptTokens ?? libraryResult.contextUsage.inputTokens,
    promptStats: libraryResult.contextUsage.promptStats,
  },
}, null, 2));

async function bundle(entry, filename) {
  await build({ entryPoints: [path.join(rootDir, entry)], outfile: path.join(stagingDir, filename), bundle: true, platform: 'node', format: 'cjs' });
}
