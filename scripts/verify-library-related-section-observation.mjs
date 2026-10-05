import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.package-staging', 'verify-library-related-section-observation');
const libraryDir = path.join(stagingDir, 'library');
const graphBundle = path.join(stagingDir, 'libraryPlanAgentGraph.cjs');
const noteIndexBundle = path.join(stagingDir, 'noteIndex.cjs');
const projectorBundle = path.join(stagingDir, 'planAwarePromptProjector.cjs');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(libraryDir, { recursive: true });
fs.copyFileSync(
  path.join(rootDir, 'scripts', 'fixtures', 'library-section-bm25', 'agent-same-headings.md'),
  path.join(libraryDir, 'agent-same-headings.md'),
);

await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryPlanAgentGraph.ts')],
    outfile: graphBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')],
    outfile: noteIndexBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planAwarePromptProjector.ts')],
    outfile: projectorBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
]);

const { createLibraryNoteSnapshotMap, runLibraryPlanAgent } = await import(pathToFileURL(graphBundle).href);
const { buildNoteIndex } = await import(pathToFileURL(noteIndexBundle).href);
const { PlanAwarePromptProjector } = await import(pathToFileURL(projectorBundle).href);

const sessionId = 'session-library-section-shadow';
const index = buildNoteIndex(libraryDir);
const snapshotMap = createLibraryNoteSnapshotMap({ libraryPath: libraryDir, index, sessionId, revision: 1, indexState: 'latest' });
const record = [...snapshotMap.records.values()][0];
assert.ok(record, 'fixture note must be indexed');
assert.equal(record.localSnapshot.headings.length, 8, 'fixture must expose eight Agent sections');
assert.equal(new Set(record.localSnapshot.headings.map((heading) => heading.headingId)).size, 8, 'real snapshots must disambiguate repeated heading IDs');
const firstBodyBlock = record.localSnapshot.blocks.find((block) => block.kind !== 'heading' && block.kind !== 'frontmatter' && block.text.includes('Memory'));
assert.ok(firstBodyBlock, 'fixture must expose the Memory body block');
const firstHeadingId = record.localSnapshot.headings[0]?.headingId;
assert.ok(firstHeadingId, 'fixture must expose the first Agent heading');

const searchCallbacks = {
  keywordSearch: () => [{
    path: index.notes[0].path,
    title: index.notes[0].title,
    score: 1,
    snippet: 'Agent Memory fixture',
    terms: ['Agent', 'Memory'],
  }],
  semanticSearch: async () => [],
};

const goalId = 'goal-library-section-shadow';
const createPlan = (activeGoalId = goalId) => ({
  planId: 'plan-library-section-shadow',
  version: 1,
  originalQuestion: 'Agent 的 Memory 机制是什么？',
  goals: [{
    goalId,
    question: '核实 Agent 的 Memory 原文',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-memory', label: 'Memory 原文', minEvidence: 1 }],
    queryTerms: [
      { term: 'Agent', source: 'planner' },
      { term: 'Memory', source: 'planner' },
    ],
    status: 'pending',
    evidenceBindings: [],
    conflictBindings: [],
  }],
  activeGoalId,
  status: 'active',
  revisionCount: 0,
  goalUpdateCount: 0,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

const navigationQueryTerms = [
  'Agent', 'Memory', '已核验', '会话', '事实', '来源', '长期', '记忆',
  'Tools', '受控', '执行', '文件', '命令', '调用', '结果', '观察',
  'Planning', '复杂', '问题', '目标', '要求', '步骤',
  'Retrieval', '笔记库', '定位', '候选', '内容', '原文', '读取', '证据',
  'Evidence', '记录', '不可变', '快照', '范围', '哈希', '引用', '身份',
].map((term) => ({ term, source: 'planner' }));

function createNavigationPlan() {
  const plan = createPlan();
  plan.planId = 'plan-library-section-navigation';
  plan.originalQuestion = '比较 Agent 的相关机制';
  plan.goals[0].question = '核实 Agent 的相关机制原文';
  plan.goals[0].queryTerms = navigationQueryTerms;
  return plan;
}

const tool = (name, argumentsValue) => ({
  type: 'tool',
  goalId,
  tool: name,
  arguments: argumentsValue,
  publicRationale: `验证 ${name}`,
});

function createSuccessfulDriver(promptLog) {
  let step = 0;
  return {
    async decide({ prompt }) {
      promptLog.push(prompt);
      if (step === 0) {
        step += 1;
        return tool('search_note_library', { limit: 8 });
      }
      if (step === 1) {
        step += 1;
        return tool('read_library_note_range', {
          noteId: record.noteId,
          lineFrom: firstBodyBlock.lineFrom,
          lineTo: firstBodyBlock.lineTo,
        });
      }
      if (step === 2) {
        step += 1;
        return tool('read_library_note_section', { noteId: record.noteId, headingId: firstHeadingId });
      }
      const evidenceIds = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
      assert.ok(evidenceIds.length > 0, 'successful reads must expose ledger evidence to the next decision');
      const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
      step += 1;
      return {
        type: 'answer',
        answer: 'Memory 保存已经核验的会话事实。',
        citations: evidenceIds,
        completeness: 'complete',
        planPatch: {
          baseVersion: version,
          activeGoalId: null,
          goalUpdates: [{
            goalId,
            status: 'covered',
            evidenceBindings: [{ requirementId: 'req-memory', evidenceIds: [evidenceIds[0]] }],
          }],
        },
      };
    },
    async synthesize() {
      throw new Error('successful scenario should answer atomically');
    },
  };
}

async function runSuccessfulScenario(sectionRankShadowMode) {
  const detailedTrace = [];
  const prompts = [];
  const result = await runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: 'Agent 的 Memory 机制是什么？',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    signal: new AbortController().signal,
    planner: { plan: async () => createPlan() },
    driver: createSuccessfulDriver(prompts),
    search: searchCallbacks,
    searchMode: 'keyword',
    isSnapshotCurrent: () => true,
    sectionRankShadowMode,
    onDetailedTrace: (entry) => detailedTrace.push(entry),
  });
  return { detailedTrace, prompts, result };
}

const shadowOff = await runSuccessfulScenario('off');
const shadowOn = await runSuccessfulScenario('observe');
const shadowEntries = shadowOn.detailedTrace.filter((entry) => entry.action === 'library-section-rank-shadow');

assert.equal(shadowOff.detailedTrace.filter((entry) => entry.action === 'library-section-rank-shadow').length, 0, 'off mode must not execute section ranking');
assert.equal(shadowEntries.length, 2, 'the two successful read tools must each execute shadow ranking exactly once');
assert.deepEqual(shadowEntries.map((entry) => entry.input.sourceTool), ['read_library_note_range', 'read_library_note_section']);
assert.equal(
  shadowEntries.every((entry) => entry.stage === 'validation' && entry.status === 'completed' && entry.callKind === 'shadow'),
  true,
  JSON.stringify(shadowEntries),
);

const firstDiagnostic = shadowEntries[0].output;
const secondDiagnostic = shadowEntries[1].output;
const expectedDiagnosticKeys = [
  'ambiguous',
  'cacheHit',
  'elapsedMs',
  'evaluatedSectionCount',
  'fallbackUsed',
  'goalId',
  'noteId',
  'queryTermCount',
  'schemaVersion',
  'snapshotId',
  'sourceTool',
  'top3Ids',
];
assert.deepEqual(Object.keys(firstDiagnostic).sort(), expectedDiagnosticKeys, 'shadow output must stay bounded to controlled diagnostics');
assert.equal(firstDiagnostic.queryTermCount, 2);
assert.equal(firstDiagnostic.evaluatedSectionCount, 8);
assert.equal(firstDiagnostic.ambiguous, false);
assert.equal(firstDiagnostic.fallbackUsed, false);
assert.equal(firstDiagnostic.cacheHit, false);
assert.equal(firstDiagnostic.top3Ids[0], firstHeadingId, 'Memory section must remain the first related section');
assert.equal(secondDiagnostic.cacheHit, true, 'the second read must reuse the snapshot/query cached rank result');
assert.deepEqual(secondDiagnostic.top3Ids, firstDiagnostic.top3Ids);

assert.equal(shadowOn.result.answer, shadowOff.result.answer);
assert.deepEqual(shadowOn.result.evidence, shadowOff.result.evidence);
assert.equal(shadowOn.result.completeness, shadowOff.result.completeness);
assert.equal(shadowOn.result.toolStats.calls, shadowOff.result.toolStats.calls, 'shadow must not consume tool-call budget');
assert.equal(shadowOn.result.agentStats.modelCalls, shadowOff.result.agentStats.modelCalls, 'shadow must not consume model-call budget');
assert.equal(shadowOn.result.prefixFingerprint, shadowOff.result.prefixFingerprint, 'shadow must not alter the final Prompt projection');
assert.deepEqual(shadowOn.prompts, shadowOff.prompts, 'shadow diagnostics must not enter the next ReAct Prompt');
assert.equal(shadowOn.prompts.some((prompt) => prompt.includes('library-section-rank-shadow') || prompt.includes('evaluatedSectionCount')), false);

async function runNoShadowScenario({ planner, driver, isSnapshotCurrent = () => true }) {
  const detailedTrace = [];
  const result = await runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: 'Agent 的 Memory 机制是什么？',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    signal: new AbortController().signal,
    planner,
    driver,
    search: searchCallbacks,
    searchMode: 'keyword',
    isSnapshotCurrent,
    sectionRankShadowMode: 'observe',
    onDetailedTrace: (entry) => detailedTrace.push(entry),
  });
  return { detailedTrace, result };
}

let failedReadStep = 0;
const failedRead = await runNoShadowScenario({
  planner: { plan: async () => createPlan() },
  driver: {
    async decide({ prompt }) {
      if (failedReadStep === 0) {
        failedReadStep += 1;
        return tool('search_note_library', { limit: 8 });
      }
      if (failedReadStep === 1) {
        failedReadStep += 1;
        return tool('read_library_note_section', { noteId: record.noteId, headingId: 'missing-heading' });
      }
      const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
      return {
        type: 'answer',
        answer: '未读取到原文。',
        citations: [],
        completeness: 'not-found',
        planPatch: { baseVersion: version, activeGoalId: null, goalUpdates: [{ goalId, status: 'not-found' }] },
      };
    },
    async synthesize() {
      throw new Error('failed-read scenario should answer atomically');
    },
  },
});
assert.equal(failedRead.detailedTrace.filter((entry) => entry.action === 'library-section-rank-shadow').length, 0, 'a rejected read must not execute shadow ranking');

const stale = await runNoShadowScenario({
  planner: { plan: async () => { throw new Error('stale snapshot must skip planning'); } },
  driver: { decide: async () => { throw new Error('stale snapshot must skip decisions'); }, synthesize: async () => { throw new Error('stale snapshot must skip synthesis'); } },
  isSnapshotCurrent: () => false,
});
assert.equal(stale.detailedTrace.filter((entry) => entry.action === 'library-section-rank-shadow').length, 0, 'a stale snapshot must not execute shadow ranking');

const noActiveGoal = await runNoShadowScenario({
  planner: { plan: async () => {
    const plan = createPlan(null);
    plan.goals[0].status = 'not-found';
    return plan;
  } },
  driver: {
    decide: async () => { throw new Error('a plan without activeGoalId must not execute tools'); },
    synthesize: async () => ({ type: 'answer', answer: '没有活动目标。', citations: [], completeness: 'not-found' }),
  },
});
assert.equal(noActiveGoal.detailedTrace.filter((entry) => entry.action === 'library-section-rank-shadow').length, 0, 'a plan without activeGoalId must not execute shadow ranking');

async function runNavigationScenario(mode) {
  const detailedTrace = [];
  const prompts = [];
  let step = 0;
  let selectedCandidateHeadingId;
  const result = await runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: '比较 Agent 的相关机制',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    signal: new AbortController().signal,
    planner: { plan: async () => createNavigationPlan() },
    driver: {
      async decide({ prompt }) {
        prompts.push(prompt);
        if (step === 0) {
          step += 1;
          return tool('search_note_library', { limit: 8 });
        }
        if (step === 1) {
          step += 1;
          return tool('read_library_note_range', {
            noteId: record.noteId,
            lineFrom: firstBodyBlock.lineFrom,
            lineTo: firstBodyBlock.lineTo,
          });
        }
        if (step === 2) {
          const candidateHeadingIds = [...prompt.matchAll(/headingId=([^\s]+)/gu)].map((match) => match[1]);
          assert.equal(candidateHeadingIds.length, 3, `next decide Prompt must expose Top 3: ${prompt}`);
          assert.equal(candidateHeadingIds.includes(firstHeadingId), false, 'the just-read Memory section must be excluded');
          assert.equal((prompt.match(/preview=/gu) ?? []).length, 3, 'level 0/1 must keep all three bounded previews');
          assert.equal(prompt.includes('score=') && prompt.includes('matched=') && prompt.includes('path='), true);
          assert.match(prompt, /必须调用 read_library_note_section 后，候选原文才是可引用证据/u);
          selectedCandidateHeadingId = candidateHeadingIds[0];
          step += 1;
          if (mode === 'explicit-read') {
            return tool('read_library_note_section', { noteId: record.noteId, headingId: selectedCandidateHeadingId });
          }
          const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
          return {
            type: 'answer',
            answer: '这个候选标题被错误地当成了证据。',
            citations: [selectedCandidateHeadingId],
            completeness: 'complete',
            planPatch: {
              baseVersion: version,
              activeGoalId: null,
              goalUpdates: [{
                goalId,
                status: 'covered',
                evidenceBindings: [{ requirementId: 'req-memory', evidenceIds: [selectedCandidateHeadingId] }],
              }],
            },
          };
        }

        assert.equal(mode, 'explicit-read');
        const evidenceIds = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
        assert.equal(evidenceIds.length, 2, 'an explicit candidate read must add a second evidenceId');
        const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
        step += 1;
        return {
          type: 'answer',
          answer: '已显式读取推荐章节并完成核验。',
          citations: evidenceIds,
          completeness: 'complete',
          planPatch: {
            baseVersion: version,
            activeGoalId: null,
            goalUpdates: [{
              goalId,
              status: 'covered',
              evidenceBindings: [{ requirementId: 'req-memory', evidenceIds: [evidenceIds[0]] }],
            }],
          },
        };
      },
      async synthesize() {
        throw new Error('navigation scenarios should answer atomically');
      },
    },
    search: searchCallbacks,
    searchMode: 'keyword',
    isSnapshotCurrent: () => true,
    sectionRankShadowMode: 'observe',
    sectionRankNavigationMode: 'observe',
    onDetailedTrace: (entry) => detailedTrace.push(entry),
  });
  return { detailedTrace, prompts, result, selectedCandidateHeadingId };
}

const citationNegative = await runNavigationScenario('citation-negative');
const citationNavigationEntries = citationNegative.detailedTrace.filter((entry) => entry.action === 'library-section-navigation-observation');
assert.equal(citationNavigationEntries.length, 1);
const navigationObservation = citationNavigationEntries[0].output;
assert.equal(navigationObservation.topSections.length, 3);
assert.equal(navigationObservation.topSections.some((candidate) => candidate.headingId === firstHeadingId), false);
assert.equal(navigationObservation.topSections.reduce((total, candidate) => total + candidate.preview.length, 0) <= 720, true);
assert.equal(citationNegative.result.evidence.length, 1, 'unread candidates must not change Ledger cardinality');
assert.equal(citationNegative.result.searchPlan.goals[0].evidenceBindings.length, 0, 'candidate bindings must be atomically rejected');
assert.equal(citationNegative.result.answer.includes('候选标题被错误地当成了证据'), false, 'candidate headingId must be rejected as a citation');
assert.equal(citationNegative.result.completeness, 'partial');
assert.equal(citationNegative.result.evidence.some((evidence) => evidence.evidenceId === citationNegative.selectedCandidateHeadingId), false);

const explicitRead = await runNavigationScenario('explicit-read');
const explicitNavigationEntries = explicitRead.detailedTrace.filter((entry) => entry.action === 'library-section-navigation-observation');
assert.equal(explicitNavigationEntries.length, 2, 'each successful explicit read must refresh the latest observation');
assert.equal(explicitRead.result.evidence.length, 2, 'explicit read must add a real evidenceId');
assert.equal(explicitRead.result.answer, '已显式读取推荐章节并完成核验。');
assert.equal(
  explicitNavigationEntries[1].output.topSections.some((candidate) => candidate.headingId === explicitRead.selectedCandidateHeadingId),
  false,
  'the explicitly read candidate must be excluded from the refreshed recommendation',
);

const projectionPlan = createNavigationPlan();
projectionPlan.goals[0].status = 'searching';
projectionPlan.goals[0].evidenceBindings = [{ requirementId: 'req-memory', evidenceIds: [navigationObservation.sourceEvidenceId] }];
const projectionEvidence = [{
  evidenceId: navigationObservation.sourceEvidenceId,
  noteId: record.noteId,
  snapshotId: record.snapshotId,
  contentHash: record.contentHash,
  lineFrom: firstBodyBlock.lineFrom,
  lineTo: firstBodyBlock.lineTo,
  text: firstBodyBlock.text,
}];
const olderObservation = { ...navigationObservation, sourceEvidenceId: 'evidence-000000000000000000000000', topSections: [] };
const buildProjection = (callKind, projectionLevel) => new PlanAwarePromptProjector().build({
  callKind,
  stablePrefix: '[fixture policy]',
  question: '比较 Agent 的相关机制',
  plan: projectionPlan,
  baseVersion: projectionPlan.version,
  evidence: projectionEvidence,
  recentEvidenceIds: [navigationObservation.sourceEvidenceId],
  navigationObservations: [olderObservation, navigationObservation],
  projectionLevel,
  outputSchema: '{"type":"object"}',
});
const projection0 = buildProjection('decide', 0);
const projection1 = buildProjection('decide', 1);
const projection3 = buildProjection('decide', 3);
const projection4 = buildProjection('decide', 4);
const navigation0 = projection0.segments.find((segment) => segment.id === 'navigation-observations');
const navigation1 = projection1.segments.find((segment) => segment.id === 'navigation-observations');
const navigation3 = projection3.segments.find((segment) => segment.id === 'navigation-observations');
const navigation4 = projection4.segments.find((segment) => segment.id === 'navigation-observations');
assert.ok(navigation0 && navigation1 && navigation3 && navigation4);
assert.equal(navigation0.protected, false, 'navigation candidates must never become protected evidence');
assert.equal(navigation0.text.includes(navigationObservation.sourceEvidenceId), true, 'only the latest active-goal observation may be projected');
assert.equal(navigation0.text.includes(olderObservation.sourceEvidenceId), false);
assert.equal((navigation0.text.match(/preview=/gu) ?? []).length, 3);
assert.equal((navigation1.text.match(/preview=/gu) ?? []).length, 3, 'projection level 1 must keep all bounded previews');
assert.equal(navigation3.text.includes('preview='), false, 'projection level 3 must remove previews');
assert.equal(navigationObservation.topSections.every((candidate) => navigation3.text.includes(`headingId=${candidate.headingId}`)), true);
assert.equal(navigation4.text.includes('candidates=3'), true);
assert.equal(navigationObservation.topSections.every((candidate) => !navigation4.text.includes(`headingId=${candidate.headingId}`)), true, 'projection level 4 must keep summary only');
assert.equal(navigation0.text.length > navigation3.text.length && navigation3.text.length > navigation4.text.length, true);
const protectedSegmentText = (projection) => projection.segments.filter((segment) => segment.protected).map((segment) => `${segment.id}:${segment.text}`);
assert.deepEqual(protectedSegmentText(projection3), protectedSegmentText(projection0), 'level 3 must preserve every protected segment byte-for-byte');
assert.deepEqual(protectedSegmentText(projection4), protectedSegmentText(projection0), 'level 4 must preserve every protected segment byte-for-byte');
assert.equal(projection4.segments.find((segment) => segment.id === 'evidence-directory')?.text.includes(navigationObservation.sourceEvidenceId), true, 'level 4 must retain bound evidence');

const synthesisProjection = buildProjection('synthesize', 0);
assert.equal(synthesisProjection.segments.some((segment) => segment.id === 'navigation-observations'), false, 'synthesize must never receive navigation candidates');
assert.equal(synthesisProjection.segments.find((segment) => segment.id === 'synthesis-evidence')?.protected, true);
assert.equal(synthesisProjection.prompt.includes(navigationObservation.topSections[0].preview), false);

console.log(JSON.stringify({
  verifier: 'library-related-section-observation-v2',
  successfulReadShadowRuns: shadowEntries.length,
  sourceTools: shadowEntries.map((entry) => entry.input.sourceTool),
  queryTermCount: firstDiagnostic.queryTermCount,
  evaluatedSectionCount: firstDiagnostic.evaluatedSectionCount,
  top3Ids: firstDiagnostic.top3Ids,
  repeatedReadCacheHit: secondDiagnostic.cacheHit,
  resultParity: {
    answer: shadowOn.result.answer === shadowOff.result.answer,
    citations: JSON.stringify(shadowOn.result.evidence) === JSON.stringify(shadowOff.result.evidence),
    completeness: shadowOn.result.completeness === shadowOff.result.completeness,
    toolCalls: shadowOn.result.toolStats.calls === shadowOff.result.toolStats.calls,
    modelCalls: shadowOn.result.agentStats.modelCalls === shadowOff.result.agentStats.modelCalls,
    prompts: JSON.stringify(shadowOn.prompts) === JSON.stringify(shadowOff.prompts),
  },
  skipped: { failedRead: true, staleSnapshot: true, noActiveGoal: true },
  navigation: {
    candidateCount: navigationObservation.topSections.length,
    unreadLedgerCount: citationNegative.result.evidence.length,
    explicitReadLedgerCount: explicitRead.result.evidence.length,
    citationRejected: citationNegative.result.completeness === 'partial',
    explicitlyReadHeadingExcluded: !explicitNavigationEntries[1].output.topSections.some((candidate) => candidate.headingId === explicitRead.selectedCandidateHeadingId),
  },
  projection: {
    level0Characters: navigation0.text.length,
    level1Characters: navigation1.text.length,
    level3Characters: navigation3.text.length,
    level4Characters: navigation4.text.length,
    synthesizeCandidateFree: !synthesisProjection.segments.some((segment) => segment.id === 'navigation-observations'),
  },
}, null, 2));
console.log('Library related-section navigation observation verification passed');
