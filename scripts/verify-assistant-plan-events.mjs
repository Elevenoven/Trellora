import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-assistant-plan-events');
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

const { runCurrentNoteAgent } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);

const mainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
const rendererTypes = fs.readFileSync(path.join(rootDir, 'src', 'electron.d.ts'), 'utf8');
assert.match(mainSource, /type: 'plan', event: planEvent/u);
assert.match(preloadSource, /onAssistantTurnEvent: \(callback: \(event: AssistantTurnEvent\)/u);
assert.match(rendererTypes, /CurrentNotePublicPlanEvent/u);

const markdown = '# 阶段 6 事件夹具\n\n## 目标\n\n阶段 6 只验证公开计划事件。';
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/stage6-events.md',
  title: '阶段 6 事件夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings: [
    { id: 'root', level: 1, text: '阶段 6 事件夹具', line: 1 },
    { id: 'target', level: 2, text: '目标', line: 3 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});

const planOutput = {
  scope: {
    mode: 'focused',
    coveragePolicy: 'sufficient',
    targetTopic: null,
    targetAspects: [],
  },
  goals: [{
    goalId: null,
    question: '核实阶段 6 公开事件',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-events', label: '公开事件契约', subject: null, minEvidence: 1 }],
    queryTerms: ['事件夹具'],
  }],
};
let plannerCalls = 0;
let plannerRequest;
const planner = createCurrentNotePlanDriver({
  async generateJson(request) {
    plannerCalls += 1;
    plannerRequest = request;
    return planOutput;
  },
});
let decisions = 0;
const toolEvents = [];
const planEvents = [];
const driver = {
  async decide({ prompt }) {
    decisions += 1;
    const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
    const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1]);
    const requirementId = prompt.match(/req=([^\s,]+):/u)?.[1];
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    if (decisions === 1) return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['事件夹具'] }, publicRationale: '定位核实目标' };
    if (decisions === 2) return { type: 'tool', goalId, tool: 'read_note_range', arguments: { lineFrom: 3, lineTo: 5 }, publicRationale: '读取原文证据' };
    return {
      type: 'answer',
      answer: '已根据原文核实。',
      citations: evidenceId ? [evidenceId] : [],
      completeness: 'complete',
      planPatch: {
        baseVersion: version,
        activeGoalId: null,
        goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId, evidenceIds: [evidenceId] }] }],
      },
    };
  },
  async synthesize() {
    return { type: 'answer', answer: '部分结果。', citations: [], completeness: 'partial' };
  },
};

const result = await runCurrentNoteAgent({
  snapshot,
  question: '阶段 6 事件夹具是什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'test-model',
  signal: new AbortController().signal,
  driver,
  planner,
  planMode: 'current-note',
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'stage6-events',
  isSnapshotCurrent: () => true,
  onToolEvent: (event) => toolEvents.push(event),
  onPlanEvent: (event) => planEvents.push(event),
});

assert.equal(plannerCalls, 1);
assert.equal(plannerRequest?.jsonSchema?.name, 'current_note_plan');
assert.equal(plannerRequest?.jsonSchema?.strict, true);
assert.equal(plannerRequest?.jsonSchema?.schema?.properties?.scope?.properties?.targetTopic?.anyOf?.some((entry) => entry.type === 'null'), true);
assert.equal(plannerRequest?.jsonSchema?.schema?.properties?.goals?.items?.properties?.queryTerms?.items?.type, 'string');
assert.equal(plannerRequest?.jsonSchema?.schema?.properties?.goals?.items?.properties?.queryTerms?.maxItems, 8, '初始 Planner QueryTerm 必须保持有界；运行期 queryVariant 仍由控制器分批累计。');
assert.equal(result.completeness, 'complete');
assert.deepEqual(planEvents.map((event) => `${event.phase}:${event.status}:${event.goals.map((goal) => `${goal.status}/${goal.evidenceCount}`).join(',')}`), [
  'started:active:pending/0',
  'updated:active:searching/0',
  'updated:active:searching/0',
  'updated:active:searching/0',
  'updated:active:searching/1',
  'finished:completed:covered/1',
]);
assert.equal(toolEvents.some((event) => event.tool === 'search_note'), true);
assert.equal(planEvents.filter((event) => event.plannerOutputJson).length, 1, '仅创建计划事件应保留一次 Planner JSON。');
assert.equal(planEvents[0]?.plannerOutputJson, JSON.stringify(planOutput, null, 2), '调试轨道应收到已校验的 Planner 原始 JSON。');
const searchStarted = toolEvents.find((event) => event.tool === 'search_note' && event.state === 'started');
const searchCompleted = toolEvents.find((event) => event.tool === 'search_note' && event.state === 'completed');
assert.equal(searchStarted?.inputSummary, '关键词：事件夹具；最多 8 个片段', '调试轨道应收到受控关键词与读取上限摘要');
assert.equal(searchCompleted?.outputSummary, searchCompleted?.message, '调试轨道应收到与公开结果一致的工具输出摘要');
assert.match(searchCompleted?.outputSummary ?? '', /^已定位到 \d+ 个候选片段。$/u);
assert.equal('reasoning' in (searchStarted ?? {}), false, '工具调试事件不得携带隐藏推理');
assert.equal(planEvents.some((event) => event.tool), false, 'plan event must not masquerade as a tool event');
for (const [index, event] of planEvents.entries()) {
  assert.deepEqual(Object.keys(event).sort(), index === 0
    ? ['goals', 'phase', 'plannerOutputJson', 'searchPlan', 'status']
    : ['finalQueryTerms', 'goals', 'phase', 'searchPlan', 'status']);
  assert.equal('reasoning' in event, false);
  assert.equal('path' in event, false);
  assert.equal(event.searchPlan?.goals[0]?.queryTerms[0]?.term, '事件夹具');
  assert.equal(event.searchPlan?.goals[0]?.queryTerms[0]?.source, 'planner');
  assert.equal(event.searchPlan?.goals[0]?.queryTermCount, 1);
  assert.equal(event.searchPlan?.goals[0]?.requirements[0]?.label, '公开事件契约');
  assert.equal('goalId' in (event.searchPlan?.goals[0] ?? {}), false);
  if (index > 0) assert.deepEqual(event.finalQueryTerms, ['事件夹具']);
  if (event.plannerOutputJson) {
    assert.match(event.plannerOutputJson, /"queryTerms": \[\n\s+"事件夹具"\n\s+\]/u);
    assert.equal(event.plannerOutputJson.includes('"reasoning"'), false);
  }
  for (const goal of event.goals) assert.deepEqual(Object.keys(goal).sort(), ['evidenceCount', 'label', 'status']);
}

const pathRedactionPlanner = createCurrentNotePlanDriver({
  async generateJson() {
    return {
      goals: [{
        goalId: 'goal-path-redaction',
        question: '核实 C:\\Private\\notes.md 中的内容',
        evidenceKind: 'fact',
        requirements: [{ requirementId: 'req-path-redaction', label: '路径脱敏', minEvidence: 1 }],
        queryTerms: ['路径'],
      }],
    };
  },
});
const pathRedactionResult = await pathRedactionPlanner.plan({ capsule: {}, question: '路径脱敏夹具', conversation: [], signal: new AbortController().signal, prompt: 'fixture' });
assert.equal(pathRedactionResult.plannerOutputJson?.includes('C:\\Private'), false, 'Planner JSON 不得暴露本地绝对路径。');
assert.match(pathRedactionResult.plannerOutputJson ?? '', /\[本地路径已省略\]/u);

const offEvents = [];
await runCurrentNoteAgent({
  snapshot,
  question: '普通受控检索',
  conversation: [],
  providerKind: 'ollama',
  model: 'test-model',
  signal: new AbortController().signal,
  driver: { decide: async () => ({ type: 'answer', answer: '旧路径结果。', citations: [], completeness: 'partial' }), synthesize: async () => ({ type: 'answer', answer: '旧路径结果。', citations: [], completeness: 'partial' }) },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'stage6-events-off',
  isSnapshotCurrent: () => true,
  onPlanEvent: (event) => offEvents.push(event),
});
assert.deepEqual(offEvents, [], 'off path must not publish SearchPlan events');

console.log('Assistant public SearchPlan event verification passed');
