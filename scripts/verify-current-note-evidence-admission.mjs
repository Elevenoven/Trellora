import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-evidence-admission');
const fixturePath = path.join(fixtureDir, 'phoenix-7.md');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-evidence-admission');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const reportPath = path.join(outDir, 'stage3-verification.json');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')],
    outfile: graphFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')],
    outfile: snapshotFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')],
    outfile: memoryFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')],
    outfile: planDriverFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
]);

const { runCurrentNoteAgent } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);

const markdown = await fs.readFile(fixturePath, 'utf8');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath: fixturePath,
  title: 'Phoenix-7 证据注入断链回归夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings: collectHeadings(markdown),
  revision: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
});

const phoenixHeading = findHeading('4.2 Phoenix-7 恢复窗口');
const diagnosticHeading = findHeading('4.3 Phoenix-7 诊断窗口');
assert.ok(diagnosticHeading, 'fixture must keep a near-name Phoenix-7 distractor heading');
assert.match(sectionText(phoenixHeading), /第一次 Phoenix-7 自动尝试[\s\S]*7 秒/u);
assert.match(sectionText(phoenixHeading), /第二次 Phoenix-7 自动尝试[\s\S]*31 秒/u);
assert.ok(sectionText(phoenixHeading).includes('最多进行 **2 次**'));
assert.match(sectionText(phoenixHeading), /WORKER_HEARTBEAT_LOST/u);
assert.match(sectionText(phoenixHeading), /TEMP_FILE_LOCK/u);
assert.match(sectionText(phoenixHeading), /第二次自动尝试仍然失败/u);
assert.ok(sectionText(phoenixHeading).includes('超过 **18 分钟**'));

const cases = {
  wait: {
    id: 'wait',
    question: 'Phoenix-7 当前两次等待多久，最多自动尝试几次？',
    requirementLabel: '需要 Phoenix-7 两次等待时长和最大自动尝试次数的原文。',
    queryTerms: ['Phoenix-7', '等待', '自动尝试', '恢复窗口'],
    expectedMarkers: ['7 秒', '31 秒', '最多进行 **2 次**'],
    answer: '第一次等待 7 秒，第二次等待 31 秒；同一作业版本最多进行 2 次 Phoenix-7 自动尝试。',
  },
  faults: {
    id: 'faults',
    question: '哪些故障可以进入 Phoenix-7 自动恢复？',
    requirementLabel: '需要 Phoenix-7 允许自动恢复的故障码原文。',
    queryTerms: ['Phoenix-7', '自动恢复', '故障'],
    expectedMarkers: ['WORKER_HEARTBEAT_LOST', 'TEMP_FILE_LOCK'],
    answer: '只有 WORKER_HEARTBEAT_LOST 和 TEMP_FILE_LOCK 可以进入 Phoenix-7 自动恢复。',
  },
  review: {
    id: 'review',
    question: '什么情况下作业会进入 needs-operator-review？',
    requirementLabel: '需要进入 needs-operator-review 的完整条件原文。',
    queryTerms: ['needs-operator-review', '人工审查', '自动尝试', '恢复租约'],
    expectedMarkers: ['第二次自动尝试仍然失败', '超过 **18 分钟**'],
    answer: '第二次自动尝试仍失败，或者累计恢复租约超过 18 分钟时，作业进入 needs-operator-review。',
  },
  thresholdOnly: {
    id: 'threshold-only',
    question: '仅根据累计恢复租约阈值，什么时候进入 needs-operator-review？',
    requirementLabel: '只核实累计恢复租约阈值的当前原文。',
    queryTerms: ['needs-operator-review', '恢复租约', '18 分钟'],
    expectedMarkers: ['超过 **18 分钟**'],
    forbiddenMarkers: ['第二次自动尝试仍然失败'],
    readRange: { lineFrom: 74, lineTo: 74 },
    completeness: 'partial',
    answer: '当前原文只能确认：累计恢复租约超过 18 分钟时，作业进入 needs-operator-review；未读取到其他条件。',
  },
};

const runs = {};
runs.minimalRepeatedWait = await runScenario(cases.wait, {
  strategy: 'repeat-section',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});
runs.minimalRepeatedFaults = await runScenario(cases.faults, {
  strategy: 'repeat-section',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});
runs.minimalDecisionWait = await runScenario(cases.wait, {
  strategy: 'decision-answer',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});
runs.minimalSearchReview = await runScenario(cases.review, {
  strategy: 'search-read-answer',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});
runs.minimalPartialReview = await runScenario(cases.thresholdOnly, {
  strategy: 'search-read-answer',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});
runs.minimalHistoryFaults = await runScenario(cases.faults, {
  strategy: 'decision-answer',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
  conversation: [
    { role: 'user', content: 'Phoenix-7 当前两次等待多久？' },
    { role: 'assistant', content: '当前章节正文没有加载，因此无法确认。' },
    { role: 'user', content: '哪些故障可以自动恢复？' },
    { role: 'assistant', content: '当前证据不足，未找到可引用原文。' },
  ],
});
runs.allRetrievedWait = await runScenario(cases.wait, {
  strategy: 'repeat-section',
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'off',
});
runs.nonPlannerWait = await runScenario(cases.wait, {
  strategy: 'decision-answer',
  planMode: 'off',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
});

const checks = [];
check('A01 minimal + observe must inject Phoenix-7 wait facts into synthesis', () => {
  assertPromptHasMarkers(runs.minimalRepeatedWait, cases.wait);
  assert.equal(runs.minimalRepeatedWait.result.completeness, 'complete');
  assert.equal(runs.minimalRepeatedWait.result.answer, cases.wait.answer);
  assert.ok(runs.minimalRepeatedWait.result.evidence.length > 0, 'A01 final answer must keep a current-snapshot citation');
});
check('A02 repeated section read must stop without discarding the first evidence', () => {
  for (const run of [runs.minimalRepeatedWait, runs.minimalRepeatedFaults]) {
    const completedReads = completedToolCount(run, 'read_note_section');
    const rejectedReads = rejectedToolCount(run, 'read_note_section');
    assert.equal(completedReads, 1, `A02 expected one effective section read, got ${completedReads}`);
    assert.equal(rejectedReads, 1, `A02 expected one blocked no-progress repeat, got ${rejectedReads}`);
    assert.equal(run.decisionCount, 3, 'A02 search + effective read + blocked repeat must end before a third identical read request');
    assert.ok(run.result.agentStats.stopReason === 'repeated-action');
  }
  assert.ok(runs.minimalRepeatedWait.synthesisPrompt.includes('7 秒'), 'A02 repeated-action synthesis must retain the first read evidence');
  assert.ok(runs.minimalRepeatedFaults.synthesisPrompt.includes('WORKER_HEARTBEAT_LOST'), 'A02 P7-02 synthesis must retain the first read evidence');
});
check('A03 decision citations must become minimal synthesis candidates', () => {
  assert.ok(runs.minimalDecisionWait.decisionCitationIds.length > 0, 'A03 decision answer must cite the evidence directory ID');
  assert.match(runs.minimalDecisionWait.decisionPrompts.at(-1) ?? '', /latest-evidence-observation decision-only/u);
  assert.match(runs.minimalDecisionWait.decisionPrompts.at(-1) ?? '', /Decision 的 answer 只表示停止检索/u);
  assert.doesNotMatch(runs.minimalDecisionWait.decisionPrompts.at(-1) ?? '', /原样作为最终回答/u);
  assertDecisionPromptHasMarkers(runs.minimalDecisionWait, cases.wait);
  assertPromptHasMarkers(runs.minimalDecisionWait, cases.wait);
  assert.equal(runs.minimalDecisionWait.result.completeness, 'complete');
});
check('A04 searching goal with goal evidence must not synthesize an empty prompt', () => {
  assert.ok(runs.minimalRepeatedWait.result.toolStats.readCharacters > 0, 'A04 explicit read must materialize source characters');
  assertPromptHasMarkers(runs.minimalRepeatedWait, cases.wait);
  const admissionTrace = runs.minimalRepeatedWait.detailedTraces.find((entry) => entry.action === 'resolve-goal-synthesis-candidates');
  assert.equal(admissionTrace?.status, 'completed', 'A04 controller must record a completed evidence-admission trace');
  assert.ok(admissionTrace?.output?.selectedEvidenceCount > 0, 'A04 trace must report selected current-goal evidence');
  assert.equal(JSON.stringify(admissionTrace).includes('7 秒'), false, 'A04 evidence-admission trace must not contain note text');
  assert.equal(JSON.stringify(admissionTrace).includes(fixturePath), false, 'A04 evidence-admission trace must not contain the note path');
  assert.equal(runs.minimalRepeatedWait.result.searchPlan?.status, 'completed', 'A04 valid synthesis planPatch must complete the plan');
  assert.equal(runs.minimalRepeatedWait.result.searchPlan?.goals[0]?.status, 'covered', 'A04 active goal must be covered after grounded synthesis');
});
check('A05 review answer must use both source conditions without invented context rules', () => {
  assertPromptHasMarkers(runs.minimalSearchReview, cases.review);
  assert.equal(runs.minimalSearchReview.result.answer, cases.review.answer);
  assert.doesNotMatch(runs.minimalSearchReview.result.answer, /相邻上下文缺失|租约上下文异常/u);
  assert.equal(runs.minimalSearchReview.result.coverage?.coveragePolicy, 'sufficient');
  assert.equal(runs.minimalSearchReview.result.coverage?.candidateTruncated, true, 'P7-03 may stop with sufficient evidence before every candidate page is consumed');
  assert.equal(runs.minimalSearchReview.result.coverage?.status, 'complete', 'Coverage complete means synthesis-ready, not answer verification');
});
check('A06 fresh evidence must outrank prior assistant not-found messages', () => {
  const projectedConversation = [...runs.minimalHistoryFaults.decisionPrompts, runs.minimalHistoryFaults.synthesisPrompt]
    .some((prompt) => prompt.includes('当前章节正文没有加载'));
  assert.ok(projectedConversation, 'A06 fixture must project the prior assistant failure into a model prompt');
  assertPromptHasMarkers(runs.minimalHistoryFaults, cases.faults);
  assert.equal(runs.minimalHistoryFaults.result.answer, cases.faults.answer);
});
check('A07 all-retrieved control must still send retrieved raw evidence', () => {
  assertPromptHasMarkers(runs.allRetrievedWait, cases.wait);
  assert.equal(runs.allRetrievedWait.result.completeness, 'complete');
  assert.ok(runs.allRetrievedWait.result.evidence.length > 0);
});
check('A08 non-Planner minimal control must keep its existing raw-evidence path', () => {
  assertPromptHasMarkers(runs.nonPlannerWait, cases.wait);
  assert.equal(runs.nonPlannerWait.result.completeness, 'complete');
  assert.ok(runs.nonPlannerWait.result.evidence.length > 0);
});
check('A09 threshold-only evidence must stay partial without inventing the unread failure condition', () => {
  assert.equal(runs.minimalPartialReview.result.completeness, 'partial');
  assert.equal(runs.minimalPartialReview.result.answer, cases.thresholdOnly.answer);
  assert.doesNotMatch(runs.minimalPartialReview.synthesisPrompt, /第二次自动尝试仍然失败/u);
  assert.equal(runs.minimalPartialReview.result.searchPlan?.status, 'partial');
  assert.equal(runs.minimalPartialReview.result.searchPlan?.goals[0]?.status, 'partial', 'terminal partial plan must not expose a searching goal');
});
check('A10 final trace must keep discovered/read/selected/cited and answer/plan states separate', () => {
  const finalTrace = runs.minimalSearchReview.detailedTraces.find((entry) => entry.action === 'final-evidence-admission-state');
  assert.equal(finalTrace?.input?.coverageStatus, 'complete');
  assert.ok(finalTrace?.input?.discoveredCandidateCount > 0);
  assert.ok(finalTrace?.input?.readEvidenceCount > 0);
  assert.ok(finalTrace?.output?.selectedEvidenceCount > 0);
  assert.ok(finalTrace?.output?.citedEvidenceCount > 0);
  assert.equal(finalTrace?.output?.admissionStatus, 'selected');
  assert.equal(finalTrace?.output?.planStatus, 'completed');
  assert.equal(finalTrace?.output?.completeness, 'complete');
  assert.equal(finalTrace?.output?.finalState, 'consistent');
});

const report = {
  phase: 3,
  fixture: path.relative(rootDir, fixturePath),
  verifiedBehavior: 'Coverage synthesis readiness, evidence admission stages, model completeness and terminal SearchPlan state stay distinct and consistent.',
  checks,
  runs: Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, summarizeRun(run)])),
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const failedChecks = checks.filter((current) => current.status === 'failed');
console.log(JSON.stringify({
  checks: checks.length,
  passed: checks.length - failedChecks.length,
  failed: failedChecks.length,
  report: path.relative(rootDir, reportPath),
  failures: failedChecks.map((current) => ({ name: current.name, message: current.message })),
}, null, 2));

if (failedChecks.length > 0) {
  throw new Error(`Stage 3 still has ${failedChecks.length} coverage, admission or terminal-plan regression(s).`);
}

console.log('Current-note Phoenix-7 stage 3 verification passed');

function collectHeadings(noteMarkdown) {
  return noteMarkdown.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    return match
      ? [{
          id: `fixture-heading-${String(index + 1).padStart(4, '0')}`,
          level: match[1].length,
          text: match[2].trim(),
          line: index + 1,
        }]
      : [];
  });
}

function findHeading(text) {
  const heading = snapshot.headings.find((candidate) => candidate.text === text);
  assert.ok(heading, `fixture heading is required: ${text}`);
  return heading;
}

function sectionText(heading) {
  return markdown.split(/\r?\n/u).slice(heading.lineFrom - 1, heading.lineTo).join('\n');
}

function evidenceIdsFromPrompt(prompt) {
  return [...new Set([...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]))];
}

function promptPlanVersion(prompt) {
  return Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
}

function createPlanner(testCase) {
  const goalId = `goal-phoenix-${testCase.id}`;
  const requirementId = `req-phoenix-${testCase.id}`;
  return {
    goalId,
    requirementId,
    planner: createCurrentNotePlanDriver({
      async generateJson() {
        return {
          goals: [{
            goalId,
            question: testCase.question,
            evidenceKind: 'fact',
            requirements: [{
              requirementId,
              label: testCase.requirementLabel,
              minEvidence: 1,
            }],
            queryTerms: testCase.queryTerms,
          }],
        };
      },
    }),
  };
}

async function runScenario(testCase, options) {
  const planned = createPlanner(testCase);
  const toolEvents = [];
  const detailedTraces = [];
  const decisionPrompts = [];
  let synthesisPrompt = '';
  let decisionCount = 0;
  let decisionCitationIds = [];
  const driver = {
    async decide({ prompt }) {
      decisionCount += 1;
      decisionPrompts.push(prompt);
      const plannerSearchRequired = options.planMode === 'current-note';
      if (plannerSearchRequired && decisionCount === 1) {
        return {
          type: 'tool',
          goalId: planned.goalId,
          tool: 'search_note',
          arguments: { terms: testCase.queryTerms, limit: 5 },
          publicRationale: '先定位 Phoenix-7 相关原文。',
        };
      }
      const postSearchDecision = decisionCount - (plannerSearchRequired ? 1 : 0);
      const toolAction = testCase.readRange
        ? {
          type: 'tool',
          ...(options.planMode === 'current-note' ? { goalId: planned.goalId } : {}),
          tool: 'read_note_range',
          arguments: testCase.readRange,
          publicRationale: '读取当前问题所需的精确原文范围。',
        }
        : {
          type: 'tool',
          ...(options.planMode === 'current-note' ? { goalId: planned.goalId } : {}),
          tool: 'read_note_section',
          arguments: { headingId: phoenixHeading.headingId },
          publicRationale: '读取 Phoenix-7 恢复窗口原文。',
        };
      if (options.strategy === 'repeat-section') return toolAction;
      if (postSearchDecision === 1) return toolAction;
      decisionCitationIds = evidenceIdsFromPrompt(prompt).slice(-1);
      return {
        type: 'answer',
        answer: '已读取目标章节，请进入最终合成。',
        citations: decisionCitationIds,
        completeness: 'complete',
      };
    },
    async synthesize({ prompt }) {
      synthesisPrompt = prompt;
      const factsReady = testCase.expectedMarkers.every((marker) => prompt.includes(marker))
        && !(testCase.forbiddenMarkers ?? []).some((marker) => prompt.includes(marker));
      const citations = factsReady ? evidenceIdsFromPrompt(prompt).slice(-1) : [];
      const expectedCompleteness = testCase.completeness ?? 'complete';
      const planPatch = factsReady && expectedCompleteness === 'complete' && options.planMode === 'current-note' && citations.length > 0
        ? {
            baseVersion: promptPlanVersion(prompt),
            activeGoalId: null,
            goalUpdates: [{
              goalId: planned.goalId,
              status: 'covered',
              evidenceBindings: [{
                requirementId: planned.requirementId,
                evidenceIds: citations,
              }],
            }],
          }
        : undefined;
      return {
        type: 'answer',
        answer: factsReady ? testCase.answer : '未找到能够支撑回答的当前笔记原文。',
        citations,
        completeness: factsReady ? expectedCompleteness : 'not-found',
        ...(planPatch ? { planPatch } : {}),
      };
    },
  };
  const result = await runCurrentNoteAgent({
    snapshot,
    question: testCase.question,
    conversation: options.conversation ?? [],
    providerKind: 'ollama',
    model: 'fixture-model',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver,
    ...(options.planMode === 'current-note' ? { planner: planned.planner } : {}),
    planMode: options.planMode,
    memory: new NoteConversationMemory(),
    memoryScopeKey: `evidence-admission:${testCase.id}:${options.strategy}:${options.planMode}:${options.assistantEvidenceProjectionMode}:${options.conversation?.length ?? 0}`,
    isSnapshotCurrent: () => true,
    assistantEvidenceProjectionMode: options.assistantEvidenceProjectionMode,
    evidenceCompressionMode: options.evidenceCompressionMode,
    onToolEvent: (event) => toolEvents.push(event),
    onDetailedTrace: (entry) => detailedTraces.push(entry),
  });
  return {
    result,
    toolEvents,
    decisionPrompts,
    synthesisPrompt,
    decisionCount,
    decisionCitationIds,
    detailedTraces,
  };
}

function assertPromptHasMarkers(run, testCase) {
  for (const marker of testCase.expectedMarkers) {
    assert.ok(
      run.synthesisPrompt.includes(marker),
      `synthesis prompt must contain current-note source marker: ${marker}`,
    );
  }
}

function assertDecisionPromptHasMarkers(run, testCase) {
  const prompt = run.decisionPrompts.at(-1) ?? '';
  for (const marker of testCase.expectedMarkers) {
    assert.ok(prompt.includes(marker), `latest Decision prompt must contain bounded current-goal marker: ${marker}`);
  }
}

function completedToolCount(run, tool) {
  return run.toolEvents.filter((event) => event.tool === tool && event.state === 'completed').length;
}

function rejectedToolCount(run, tool) {
  return run.toolEvents.filter((event) => event.tool === tool && event.state === 'rejected').length;
}

function check(name, assertion) {
  try {
    assertion();
    checks.push({ name, status: 'passed' });
  } catch (error) {
    checks.push({
      name,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function summarizeRun(run) {
  return {
    completeness: run.result.completeness,
    stopReason: run.result.agentStats.stopReason,
    planStatus: run.result.searchPlan?.status,
    goalStatus: run.result.searchPlan?.goals[0]?.status,
    evidenceCount: run.result.evidence.length,
    readCharacters: run.result.toolStats.readCharacters,
    decisionCount: run.decisionCount,
    completedSectionReads: completedToolCount(run, 'read_note_section'),
    rejectedSectionReads: rejectedToolCount(run, 'read_note_section'),
    completedSearches: completedToolCount(run, 'search_note'),
    decisionHasLatestEvidence: run.decisionPrompts.some((prompt) => prompt.includes('latest-evidence-observation decision-only')),
    synthesisHasRawEvidence: runsHasExpectedRawMarker(run),
  };
}

function runsHasExpectedRawMarker(run) {
  return ['7 秒', '31 秒', 'WORKER_HEARTBEAT_LOST', '第二次自动尝试仍然失败']
    .some((marker) => run.synthesisPrompt.includes(marker));
}
