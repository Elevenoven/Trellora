import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-adaptive-scope');
const fixturePath = path.join(fixtureDir, 'ner-multi-section.md');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-answer-recovery');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const actionDriverFile = path.join(outDir, 'action-driver.cjs');
const coverageFile = path.join(outDir, 'coverage.cjs');
const presentationFile = path.join(outDir, 'presentation.cjs');
const reportPath = path.join(outDir, 'baseline-v1.json');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'structuredActionDriver.ts')], outfile: actionDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSearchCoverage.ts')], outfile: coverageFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'src', 'components', 'assistantPlanPresentation.ts')], outfile: presentationFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { createStructuredActionDriver } = await import(pathToFileURL(actionDriverFile).href);
const { CurrentNoteSearchCoverageLedger } = await import(pathToFileURL(coverageFile).href);
const { getAssistantSearchCoverageView } = await import(pathToFileURL(presentationFile).href);

const markdown = await fs.readFile(fixturePath, 'utf8');
const headings = collectHeadings(markdown);
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath: fixturePath,
  title: '当前笔记 Planner 证据闭环夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings,
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
});

const cases = [
  { id: 'D01', question: '什么是 NER，请根据笔记分析？', heading: 'NER 定义', searchTerms: ['NER', '定义'], expectedEvidence: /Named Entity Recognition/u, evidenceKind: 'definition' },
  { id: 'D02', question: 'NER 模型有哪些分类？', heading: 'NER 模型分类', searchTerms: ['NER', '模型', '分类'], expectedEvidence: /spaCy|LLM 增强/u, evidenceKind: 'fact' },
  { id: 'D03', question: 'NER 数据标注要注意什么？', heading: 'NER 数据标注', searchTerms: ['NER', '数据标注'], expectedEvidence: /实体边界|嵌套实体/u, evidenceKind: 'fact' },
  { id: 'D04', question: 'NER 如何评估？', heading: 'NER 评估', searchTerms: ['NER', '评估'], expectedEvidence: /Precision|Recall|F1/u, evidenceKind: 'fact' },
  { id: 'D05', question: 'NER 部署要关注什么？', heading: 'NER 部署', searchTerms: ['NER', '部署'], expectedEvidence: /模型延迟|领域漂移|监控指标/u, evidenceKind: 'fact' },
];

for (const testCase of cases) {
  const heading = snapshot.headings.find((candidate) => candidate.text === testCase.heading);
  assert.ok(heading, `${testCase.id} fixture heading is required`);
  assert.ok(testCase.expectedEvidence.test(sectionText(heading)), `${testCase.id} fixture must contain the required source topic`);
}

function collectHeadings(noteMarkdown) {
  return noteMarkdown.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    return match
      ? [{ id: `fixture-heading-${String(index + 1).padStart(4, '0')}`, level: match[1].length, text: match[2].trim(), line: index + 1 }]
      : [];
  });
}

function sectionText(heading) {
  return markdown.split(/\r?\n/u).slice(heading.lineFrom - 1, heading.lineTo).join('\n');
}

function evidenceIdsFromPrompt(prompt) {
  return [...new Set([...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]))];
}

function planContext(prompt, goalId) {
  return {
    goalId,
    requirementId: `req-${goalId}`,
    planVersion: Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0),
    evidenceId: evidenceIdsFromPrompt(prompt).at(-1),
  };
}

function createPlanner(testCase) {
  const goalId = `goal-${testCase.id.toLowerCase()}`;
  const requirementId = `req-${goalId}`;
  return {
    goalId,
    requirementId,
    planner: createCurrentNotePlanDriver({
      async generateJson() {
        return {
          goals: [{
            goalId,
            question: testCase.question,
            evidenceKind: testCase.evidenceKind,
            requirements: [{ requirementId, label: `需要一条 ${testCase.heading} 原文证据。`, minEvidence: 1 }],
            queryTerms: testCase.searchTerms,
          }],
        };
      },
    }),
  };
}

function createDecisionDriver(testCase, mode) {
  const { goalId, requirementId } = createPlanner(testCase);
  let decisionCount = 0;
  const driver = {
    decisions: 0,
    async decide({ prompt, onRawResponse }) {
      decisionCount += 1;
      this.decisions = decisionCount;
      if (decisionCount === 1) {
        return {
          type: 'tool',
          goalId,
          tool: 'search_note',
          arguments: { terms: testCase.searchTerms, limit: 8 },
          publicRationale: '定位当前笔记中的相关原文。',
        };
      }
      if (decisionCount === 2) {
        const heading = snapshot.headings.find((candidate) => candidate.text === testCase.heading);
        return {
          type: 'tool',
          goalId,
          tool: 'read_note_section',
          arguments: { headingId: heading.headingId },
          publicRationale: '读取命中章节的原文证据。',
        };
      }
      if (mode === 'invalid-json-after-read') {
        onRawResponse?.('这是模型读取原文后给出的自由格式最终回答。');
        throw new SyntaxError('模拟非法 JSON：内部输出不应进入公开轨迹。');
      }
      const context = planContext(prompt, goalId);
      const citations = context.evidenceId ? [context.evidenceId] : [];
      const planPatch = mode === 'stale-plan-patch'
        ? {
          baseVersion: Math.max(0, context.planVersion - 1),
          activeGoalId: null,
          goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId, evidenceIds: citations }] }],
        }
        : mode === 'valid-plan-patch'
          ? {
            baseVersion: context.planVersion,
            activeGoalId: null,
            goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId, evidenceIds: citations }] }],
          }
          : undefined;
      return {
        type: 'answer',
        answer: `根据已读取的 ${testCase.heading} 原文形成回答。`,
        citations,
        completeness: 'complete',
        ...(planPatch ? { planPatch } : {}),
      };
    },
    async synthesize({ prompt }) {
      const citations = evidenceIdsFromPrompt(prompt);
      const shouldRepair = mode === 'valid-plan-patch'
        || (mode === 'missing-plan-patch' && prompt.includes('上一份最终答案未通过本地计划校验'));
      const planVersion = Number(prompt.match(/planVersion=(\d+)/u)?.[1] ?? 0);
      const planPatch = shouldRepair && citations[0]
        ? {
          baseVersion: planVersion,
          activeGoalId: null,
          goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId, evidenceIds: [citations[0]] }] }],
        }
        : undefined;
      return {
        type: 'answer',
        answer: shouldRepair ? `已依据 ${testCase.heading} 原文完成受控回答。` : '已读取相关原文，但结构化计划动作需要后续校验。',
        citations,
        completeness: citations.length > 0 ? 'complete' : 'not-found',
        ...(planPatch ? { planPatch } : {}),
      };
    },
  };
  const authoritativeDriver = createStructuredActionDriver({
    generateJson: (request) => request.callKind === 'synthesize' ? driver.synthesize(request) : driver.decide(request),
  });
  Object.defineProperty(authoritativeDriver, 'decisions', { get: () => driver.decisions });
  return { driver: authoritativeDriver, goalId, planner: createPlanner(testCase).planner };
}

function agentInput(testCase, mode, extra = {}) {
  const created = createDecisionDriver(testCase, mode);
  return {
    input: {
      snapshot,
      question: testCase.question,
      conversation: [],
      providerKind: 'ollama',
      model: 'fixture-stub',
      contextWindowTokens: 20_000,
      signal: new AbortController().signal,
      driver: created.driver,
      planner: created.planner,
      planMode: 'current-note',
      memory: new NoteConversationMemory(),
      memoryScopeKey: `answer-recovery:${testCase.id}:${mode}`,
      isSnapshotCurrent: () => true,
      ...extra,
    },
    driver: created.driver,
  };
}

async function runCase(testCase, mode, extra = {}) {
  const events = [];
  const startedAt = performance.now();
  const { input, driver } = agentInput(testCase, mode, { onToolEvent: (event) => events.push(event), ...extra });
  const result = await runCurrentNoteAgent(input);
  return { result, events, decisions: driver.decisions, elapsedMs: Number((performance.now() - startedAt).toFixed(3)) };
}

const controls = [];
const repairs = [];
for (const testCase of cases) {
  const control = await runCase(testCase, 'valid-plan-patch');
  assert.equal(control.result.completeness, 'complete', `${testCase.id} valid plan patch control must complete`);
  assert.equal(control.result.searchPlan?.status, 'completed', `${testCase.id} control plan must complete`);
  assert.equal(control.result.searchPlan?.goals[0]?.status, 'covered', `${testCase.id} control goal must be covered`);
  assert.equal(control.result.searchPlan?.goals[0]?.evidenceBindings.length, 1, `${testCase.id} control must bind one evidence record`);
  assert.equal(control.result.evidence.length, 1, `${testCase.id} control must expose one citation`);
  assert.equal(control.decisions, 3, `${testCase.id} must let ReAct decide whether to answer after search and read`);
  assert.ok(control.result.evidence[0]?.preview && testCase.expectedEvidence.test(control.result.evidence[0].preview), `${testCase.id} citation must contain the expected source topic`);
  assert.ok(control.events.some((event) => event.tool === 'search_note' && event.state === 'completed'));
  assert.ok(control.events.some((event) => event.tool === 'read_note_section' && event.state === 'completed'));
  controls.push({ id: testCase.id, completeness: control.result.completeness, planStatus: control.result.searchPlan?.status, toolCalls: control.result.toolStats.calls, evidenceCount: control.result.evidence.length });

  const missingPatch = await runCase(testCase, 'missing-plan-patch');
  assert.equal(missingPatch.result.evidence.length, 1, `${testCase.id} missing planPatch must retain the read evidence`);
  assert.equal(missingPatch.result.completeness, 'complete', `${testCase.id} model completeness must be preserved without planPatch`);
  assert.equal(missingPatch.result.searchPlan?.status, 'partial', `${testCase.id} SearchPlan may remain partial without overriding the model answer`);
  assert.equal(missingPatch.result.searchPlan?.goals[0]?.evidenceBindings.length, 0, `${testCase.id} missing planPatch must not synthesize bindings locally`);
  assert.equal(missingPatch.result.agentStats.stopReason, 'answered', `${testCase.id} first model answer must stop ReAct`);
  assert.equal(missingPatch.decisions, 3, `${testCase.id} must not trigger controller-owned answer repair`);
  repairs.push({ id: testCase.id, observedCompleteness: missingPatch.result.completeness, observedPlanStatus: missingPatch.result.searchPlan?.status, evidenceCount: missingPatch.result.evidence.length, toolCalls: missingPatch.result.toolStats.calls });
}

const r01 = await runCase(cases[0], 'invalid-json-after-read', { budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxInvalidActions: 1 } });
assert.equal(r01.result.agentStats.stopReason, 'answered', 'R01 free-form model output must end ReAct search directly');
assert.equal(r01.result.evidence.length, 1, 'R01 must synthesize a source link after raw evidence was read');
assert.equal(r01.result.completeness, 'complete', 'R01 synthesis keeps a complete answer when evidence is available');
assert.equal(r01.result.answer, '已读取相关原文，但结构化计划动作需要后续校验。');
assert.equal(r01.decisions, 3, 'R01 must not trigger a decision-format repair after free-form output');
assert.ok(r01.events.every((event) => !String(event.message ?? '').includes('内部输出')), 'R01 public events must not expose raw model errors');

const r03 = await runCase(cases[0], 'stale-plan-patch');
assert.equal(r03.result.completeness, 'complete', 'R03 stale planPatch must not downgrade the model answer');
assert.equal(r03.result.searchPlan?.status, 'partial', 'R03 stale patch may be ignored for SearchPlan projection');
assert.equal(r03.result.searchPlan?.goals[0]?.evidenceBindings.length, 0, 'R03 stale patch must not bind evidence');
assert.equal(r03.result.evidence.length, 1, 'R03 must retain the model-provided source link');
assert.equal(r03.result.answer, '已读取相关原文，但结构化计划动作需要后续校验。', 'R03 final answer must be regenerated from raw evidence');
assert.equal(r03.result.agentStats.stopReason, 'answered');

const timeoutCase = { ...cases[0], id: 'R04', question: '模拟 Provider 超时', searchTerms: ['NER'] };
const timeoutPlanner = createPlanner(timeoutCase);
let timeoutDecisions = 0;
let timeoutSignalAborted = false;
const timeoutEvents = [];
const timeoutStartedAt = performance.now();
await assert.rejects(() => runCurrentNoteAgent({
  snapshot,
  question: timeoutCase.question,
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-stub',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  planner: timeoutPlanner.planner,
  planMode: 'current-note',
  driver: {
    async decide({ signal }) {
      timeoutDecisions += 1;
      await new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('hard-timeout fixture exceeded safety bound')), 5_000);
        const onAbort = () => {
          timeoutSignalAborted = true;
          clearTimeout(keepAlive);
          signal.removeEventListener('abort', onAbort);
          reject(signal.reason ?? new DOMException('模拟 Provider timeout', 'TimeoutError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
    async synthesize() { return { type: 'answer', answer: '没有形成回答。', citations: [], completeness: 'not-found' }; },
  },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'answer-recovery:R04',
  isSnapshotCurrent: () => true,
  onToolEvent: (event) => timeoutEvents.push(event),
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxInvalidActions: 1, maxDecisionRounds: 2, maxWallTimeMs: 120 },
}), /当前模型调用无法在预算内发送|模型调用已达到本轮截止时间/u, 'R04 timeout without model output must surface a real error');
const timeoutElapsedMs = Number((performance.now() - timeoutStartedAt).toFixed(3));
assert.equal(timeoutDecisions, 1, 'R04 should issue one bounded provider attempt');
assert.equal(timeoutSignalAborted, true, 'R04 provider fixture must observe the shared deadline abort signal');
assert.ok(timeoutElapsedMs < 500, 'R04 must stop near the wall-clock budget instead of waiting for an unbounded provider timeout');
assert.ok(timeoutEvents.every((event) => !String(event.message ?? '').includes('Provider timeout')), 'R04 public events must not expose provider error text');

const nestedMarkdown = '# 父章节\n\n父级说明。\n\n## 子章节\n\nNER 子章节原文。\n\n## 兄弟章节\n\n其他原文。';
const nestedHeadings = collectHeadings(nestedMarkdown);
const nestedSnapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath: path.join(fixtureDir, 'nested-coverage.md'),
  title: 'Coverage 父子章节夹具',
  contentHash: createHash('sha256').update(nestedMarkdown, 'utf8').digest('hex'),
  markdown: nestedMarkdown,
  headings: nestedHeadings,
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
});
const nestedParent = nestedSnapshot.headings.find((heading) => heading.text === '父章节');
const nestedChild = nestedSnapshot.headings.find((heading) => heading.text === '子章节');
assert.ok(nestedParent && nestedChild);
const nestedCoverage = new CurrentNoteSearchCoverageLedger(nestedSnapshot, {
  mode: 'focused',
  coveragePolicy: 'sufficient',
  targetTopic: 'NER',
  targetAspects: ['定义'],
  origin: 'controller-fallback',
  confidence: 'low',
});
nestedCoverage.recordRead('goal-r05', {
  snapshotId: nestedSnapshot.snapshotId,
  evidenceId: 'evidence-555555555555555555555555',
  blockIds: [],
  headingPath: ['父章节', '子章节'],
  lineFrom: nestedChild.lineFrom + 1,
  lineTo: nestedChild.lineTo,
  text: 'NER 子章节原文。',
  headingId: nestedChild.headingId,
});
const r05Summary = nestedCoverage.toModelSummary('goal-r05');
assert.equal(r05Summary.readHeadingCount, 1, 'R05 explicit child heading must not double count its parent');

const r06View = getAssistantSearchCoverageView(
  { mode: 'focused', coveragePolicy: 'sufficient', targetTopic: 'NER', targetAspects: [], origin: 'controller-fallback', confidence: 'low' },
  { goalId: 'goal-r06', mode: 'focused', coveragePolicy: 'sufficient', discoveredHeadingCount: 5, readHeadingCount: 1, matchedBlockCount: 1, evidenceCount: 1, targetAspectCount: 0, coveredAspectCount: 0, remainingAspects: [], candidateTruncated: false, candidateExhausted: false, status: 'partial', reason: '仍有范围未读取原文。', goalSummaries: [] },
  'partial',
  { stopReason: 'answered' },
);
assert.equal(r06View?.coverageLabel, '已读取部分原文证据', 'R06 partial coverage must not render as completion');
assert.match(r06View?.readLabel ?? '', /已读取 1\/5 个章节/u);

const report = {
  schemaVersion: 'current-note-unrestricted-model-output-v1',
  purpose: '验证 ReAct 的自由格式模型输出直接结束，Plan/Citation/Coverage 不拦截答案，且无模型输出的超时不会生成本地替代回答。',
  fixture: { path: path.relative(rootDir, fixturePath).replace(/\\/gu, '/'), caseCount: cases.length, caseIds: cases.map((testCase) => testCase.id) },
  controls,
  repairs,
  anomalies: {
    R01: { stopReason: r01.result.agentStats.stopReason, completeness: r01.result.completeness, evidenceCount: r01.result.evidence.length },
    R02: { observedAs: 'D01 missing-plan-patch accepted without repair', completeness: repairs[0].observedCompleteness },
    R03: { completeness: r03.result.completeness, planStatus: r03.result.searchPlan?.status, boundEvidenceCount: r03.result.searchPlan?.goals[0]?.evidenceBindings.length ?? 0 },
    R04: { surfacedAsError: true, elapsedMs: timeoutElapsedMs, signalAborted: timeoutSignalAborted },
    R05: { readHeadingCount: r05Summary.readHeadingCount, expectedAfterStage4: 1 },
    R06: { coverageLabel: r06View?.coverageLabel, readLabel: r06View?.readLabel, expectedAfterStage4: '按 coverage.status 展示' },
  },
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Current-note answer recovery baseline written: ${path.relative(rootDir, reportPath).replace(/\\/gu, '/')}`);
console.log(`D01-D05 model-authoritative ReAct controls passed: ${controls.length}; missing-planPatch cases passed: ${repairs.length}; timeout boundary passed.`);
