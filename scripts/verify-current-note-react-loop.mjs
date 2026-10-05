import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-react-loop');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const driverFile = path.join(outDir, 'driver.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const promptProjectorFile = path.join(outDir, 'prompt-projector.cjs');

if (process.env.MENGHAN_CURRENT_NOTE_REACT_PREBUILT !== '1') {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'structuredActionDriver.ts')], outfile: driverFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planAwarePromptProjector.ts')], outfile: promptProjectorFile, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createStructuredActionDriver, parseCurrentNoteAgentAction } = await import(pathToFileURL(driverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { DEFAULT_DECIDE_JSON_SCHEMA, DEFAULT_PLAN_JSON_SCHEMA } = await import(pathToFileURL(promptProjectorFile).href);

const defaultDecideSchema = JSON.parse(DEFAULT_DECIDE_JSON_SCHEMA);
const defaultPlanSchema = JSON.parse(DEFAULT_PLAN_JSON_SCHEMA);
assert.equal(defaultPlanSchema.properties.goals.items.properties.queryTerms.maxItems, 8, '初始 Planner 每目标最多生成 8 个 QueryTerm。');
assert.equal(DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxWallTimeMs, undefined, '默认当前笔记 ReAct 不应设置墙钟截止。');
const publicRationaleBranches = defaultDecideSchema.properties.publicRationale.anyOf;
assert.ok(publicRationaleBranches.some((branch) => branch.type === 'string' && branch.minLength === 1 && branch.maxLength === 80));
const toolArgumentUnion = defaultDecideSchema.properties.arguments.anyOf.find((branch) => Array.isArray(branch.anyOf));
const cursorArgumentBranches = toolArgumentUnion.anyOf.filter((branch) => branch.required?.includes('cursor'));
assert.equal(cursorArgumentBranches.length, 2, 'search_note 与 read_note_section 的强 Schema 都必须要求 nullable cursor。');

const markdown = `# 总览

${'前言内容。'.repeat(260)}

## 尾部证据

尾部唯一结论：受控 ReAct 必须读取原文后才能回答。`;
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/react.md',
  title: 'ReAct 夹具',
  contentHash,
  markdown,
  headings: [
    { id: 'overview', level: 1, text: '总览', line: 1 },
    { id: 'tail', level: 2, text: '尾部证据', line: 5 },
  ],
  revision: 1,
  createdAt: '2026-08-21T00:00:00.000Z',
});
assert.ok(snapshot.markdown.length > 1_200, 'fixture must require the ReAct route');

function agentInput(driver, memory = new NoteConversationMemory(), extra = {}) {
  return {
    snapshot,
    question: '尾部结论是什么？',
    conversation: [],
    providerKind: 'ollama',
    model: 'qwen3',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver,
    memory,
    memoryScopeKey: 'window-1:react',
    isSnapshotCurrent: () => true,
    ...extra,
  };
}

function evidenceIdsFromPrompt(prompt) {
  return [...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]);
}

let decisionCount = 0;
const evidenceDriver = {
  async decide({ prompt }) {
    decisionCount += 1;
    if (decisionCount === 1) return { type: 'tool', tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '定位尾部结论所在的原文。' };
    if (decisionCount === 2) return { type: 'tool', tool: 'read_note_range', arguments: { lineFrom: 7, lineTo: 7 }, publicRationale: '读取命中行的原文证据。' };
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '尾部结论要求先读取原文，再形成回答。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '根据已读取原文，结论是先取证后回答。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
};
const memory = new NoteConversationMemory();
const first = await runCurrentNoteAgent(agentInput(evidenceDriver, memory));
assert.equal(first.contextMode, 'react-search');
assert.equal(first.completeness, 'complete');
assert.equal(first.answer, '根据已读取原文，结论是先取证后回答。');
assert.equal(first.evidence.length, 1);
assert.equal(first.agentStats.decisionRounds, 3);
assert.equal(first.toolStats.calls, 2);
assert.deepEqual(first.agentMessages.map((message) => message.role), ['assistant', 'tool', 'assistant', 'tool']);
assert.equal(first.agentMessages[0].toolCalls[0].toolName, 'search_note');
assert.equal(first.agentMessages[1].toolCallId, first.agentMessages[0].toolCalls[0].callId);
assert.equal(first.agentMessages[2].toolCalls[0].toolName, 'read_note_range');
assert.equal(first.agentMessages[3].toolCallId, first.agentMessages[2].toolCalls[0].callId);
assert.ok(first.agentStats.decisionRounds <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxDecisionRounds);
assert.ok(first.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);

let directSynthesisCalls = 0;
const directNoEvidenceDriver = {
  async decide() { return { type: 'answer', answer: '需要补充具体章节或关键词。', citations: [], completeness: 'partial' }; },
  async synthesize() { directSynthesisCalls += 1; throw new Error('无证据的澄清回答不应进入综合阶段'); },
};
const directNoEvidence = await runCurrentNoteAgent(agentInput(directNoEvidenceDriver, new NoteConversationMemory(), {
  question: '这个？',
  memoryScopeKey: 'window-1:direct-no-evidence',
}));
assert.equal(directNoEvidence.answer, '需要补充具体章节或关键词。');
assert.equal(directNoEvidence.evidence.length, 0);
assert.equal(directSynthesisCalls, 0, '未读取正文时保留模型的直接澄清回答');

let detailedSynthesisPrompt = '';
const detailedDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_range', arguments: { lineFrom: 7, lineTo: 7 }, publicRationale: '读取尾部结论原文。' };
    return { type: 'answer', answer: '已可回答。', citations: [], completeness: 'complete' };
  },
  async synthesize({ prompt }) {
    detailedSynthesisPrompt = prompt;
    return { type: 'answer', answer: '详细回答已基于原文生成。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' };
  },
};
const detailed = await runCurrentNoteAgent(agentInput(detailedDriver, new NoteConversationMemory(), {
  answerDepth: 'detailed',
  memoryScopeKey: 'window-1:detailed-answer',
}));
assert.equal(detailed.answer, '详细回答已基于原文生成。');
assert.match(detailedSynthesisPrompt, /回答深度：详细/u);
assert.match(detailedSynthesisPrompt, /原理、关键步骤、示例、适用边界/u);
assert.match(detailedSynthesisPrompt, /尾部唯一结论：受控 ReAct 必须读取原文后才能回答/u);

const memoryReuseDriver = {
  async decide() { throw new Error('memory-reuse must not call the planner'); },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '复用了当前窗口内已验证的证据。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
};
const reused = await runCurrentNoteAgent(agentInput(memoryReuseDriver, memory));
assert.equal(reused.contextMode, 'memory-reuse');
assert.equal(reused.toolStats.calls, 0);

const repeatedDriver = {
  async decide() { return { type: 'tool', tool: 'get_note_map', arguments: {}, publicRationale: '读取结构地图。' }; },
  async synthesize() { return { type: 'answer', answer: '结构地图不能单独证明结论。', citations: [], completeness: 'partial' }; },
};
const repeated = await runCurrentNoteAgent(agentInput(repeatedDriver));
assert.equal(repeated.agentStats.stopReason, 'repeated-action');
assert.equal(repeated.toolStats.calls, 1);

const repeatedSectionEvents = [];
const repeatedSectionDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail' }, publicRationale: '重复请求已读完的尾部章节。' };
  },
  async synthesize({ prompt }) {
    return { type: 'answer', answer: '已使用首次章节读取结果。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' };
  },
};
const repeatedSection = await runCurrentNoteAgent(agentInput(repeatedSectionDriver, new NoteConversationMemory(), {
  memoryScopeKey: 'window-1:repeated-exhausted-section',
  onToolEvent: (event) => repeatedSectionEvents.push(event),
}));
assert.equal(repeatedSection.agentStats.stopReason, 'repeated-action');
assert.equal(repeatedSection.toolStats.calls, 1, 'blocked exhausted read must not consume another tool call');
assert.equal(repeatedSectionDriver.count, 2, 'the second identical request must terminate before a third decision');
assert.equal(repeatedSectionEvents.filter((event) => event.tool === 'read_note_section' && event.state === 'completed').length, 1);
assert.equal(repeatedSectionEvents.filter((event) => event.tool === 'read_note_section' && event.state === 'rejected').length, 1);
assert.equal(repeatedSection.evidence.length, 1, 'the blocked repeat must preserve evidence from the effective read');

let synthesisRepairCalls = 0;
const synthesisRepairDriver = {
  async decide() { return { type: 'tool', tool: 'get_note_map', arguments: {}, publicRationale: '读取结构地图。' }; },
  async synthesize() {
    synthesisRepairCalls += 1;
    throw new SyntaxError('invalid JSON from provider');
  },
};
await assert.rejects(
  () => runCurrentNoteAgent(agentInput(synthesisRepairDriver)),
  /invalid JSON from provider/u,
  '没有原始模型输出时必须抛出真实错误，不能生成本地替代回答',
);
assert.equal(synthesisRepairCalls, 1, '最终合成格式失败不得触发本地纠错重试');

let plannerRepairCalls = 0;
let plannerRepairPromptSeen = false;
let plannerFullPolicySeen = false;
let plannerRepairSchemaName;
const repairablePlanner = createCurrentNotePlanDriver({
  async generateJson({ prompt, jsonSchema }) {
    plannerRepairCalls += 1;
    if (plannerRepairCalls === 1) {
      plannerFullPolicySeen = /每个目标 1 到 8 个/u.test(prompt)
        && /不得输出 JSON 字段名、纯标点/u.test(prompt);
      return {
        scope: { mode: 'focused', coveragePolicy: 'aspect-complete', targetTopic: '尾部结论', targetAspects: [] },
        goals: [{
          goalId: null,
          question: '尾部结论是什么？',
          evidenceKind: 'fact',
          requirements: [{ requirementId: 'req-tail', label: '尾部结论', subject: null, minEvidence: 1 }],
          queryTerms: ['尾部结论'],
        }],
      };
    }
    plannerRepairPromptSeen = /\[Planner 字段级修复策略\]/u.test(prompt)
      && /允许修复字段：scope\.coveragePolicy/u.test(prompt)
      && /禁止输出完整 scope、goals/u.test(prompt);
    plannerRepairSchemaName = jsonSchema?.name;
    return { repairs: [{ path: 'scope.coveragePolicy', value: 'sufficient' }] };
  },
});
let plannerDecisionCalls = 0;
const plannerRepairDriver = {
  async decide({ prompt }) {
    plannerDecisionCalls += 1;
    const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1];
    const version = Number(prompt.match(/planVersion=(\d+)/u)?.[1]);
    const requirementId = prompt.match(/req=([^\s,]+):/u)?.[1];
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    if (plannerDecisionCalls === 1) return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '定位尾部结论。' };
    if (plannerDecisionCalls === 2) return { type: 'tool', goalId, tool: 'read_note_section', arguments: { headingId: 'tail' }, publicRationale: '读取尾部原文。' };
    return {
      type: 'answer',
      answer: '尾部结论已读取。',
      citations: evidenceId ? [evidenceId] : [],
      completeness: 'complete',
      planPatch: {
        baseVersion: version,
        activeGoalId: null,
        goalUpdates: [{ goalId, status: 'covered', evidenceBindings: [{ requirementId, evidenceIds: [evidenceId] }] }],
      },
    };
  },
  async synthesize() { return { type: 'answer', answer: 'Planner 纠错后完成。', citations: [], completeness: 'partial' }; },
};
await runCurrentNoteAgent(agentInput(plannerRepairDriver, new NoteConversationMemory(), {
  planner: repairablePlanner,
  planMode: 'current-note',
  memoryScopeKey: 'window-1:planner-repair',
}));
assert.equal(plannerRepairCalls, 2, 'invalid Planner output receives one bounded field-level retry');
assert.equal(plannerFullPolicySeen, true, 'Agent Graph 必须发送完整 Planner 规则。');
assert.equal(plannerRepairPromptSeen, true);
assert.equal(plannerRepairSchemaName, 'current_note_plan_field_repair');

const emptySearchDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    return { type: 'tool', tool: 'search_note', arguments: { terms: [`unfindable_token_${this.count}`] }, publicRationale: '尝试定位证据。' };
  },
  async synthesize() { return { type: 'answer', answer: '未找到原文证据。', citations: [], completeness: 'not-found' }; },
};
const emptyEvents = [];
const empty = await runCurrentNoteAgent(agentInput(emptySearchDriver, new NoteConversationMemory(), {
  onToolEvent: (event) => emptyEvents.push(event),
}));
assert.equal(DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls, 10);
assert.equal(empty.agentStats.stopReason, 'max-tool-calls');
assert.equal(empty.agentStats.decisionRounds, 10);
assert.equal(empty.toolStats.calls, 10);
assert.equal(emptySearchDriver.count, 10);
assert.equal(emptyEvents.filter((event) => event.tool === 'search_note' && event.state === 'completed' && event.message === '未找到匹配片段。').length, 10);

const sharedTurnBudgetDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    return { type: 'tool', tool: 'search_note', arguments: { terms: [`shared_budget_empty_${this.count}`] }, publicRationale: '在本轮剩余额度内继续定位。' };
  },
  async synthesize() { return { type: 'answer', answer: '共享额度耗尽后停止。', citations: [], completeness: 'not-found' }; },
};
const sharedTurnEvents = [];
const sharedTurn = await runCurrentNoteAgent(agentInput(sharedTurnBudgetDriver, new NoteConversationMemory(), {
  toolCallsAlreadyUsed: 1,
  onToolEvent: (event) => sharedTurnEvents.push(event),
}));
assert.equal(sharedTurn.agentStats.stopReason, 'max-tool-calls');
assert.equal(sharedTurn.toolStats.calls, DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);
assert.equal(sharedTurnEvents.filter((event) => event.state === 'completed').length, DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls - 1);

const invalidDriver = {
  async decide() { throw new Error('invalid JSON'); },
  async synthesize() { return { type: 'answer', answer: '模型动作无效，无法继续。', citations: [], completeness: 'not-found' }; },
};
const invalid = await runCurrentNoteAgent(agentInput(invalidDriver));
assert.equal(invalid.agentStats.stopReason, 'invalid-action');
assert.equal(invalid.agentStats.decisionRounds, DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxInvalidActions);

const sectionDriver = {
  count: 0,
  async decide({ prompt }) {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail' }, publicRationale: '读取尾部章节原文。' };
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '尾部章节已读取。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
  async synthesize({ prompt }) { return { type: 'answer', answer: '尾部章节已读取。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' }; },
};
const section = await runCurrentNoteAgent(agentInput(sectionDriver));
assert.equal(section.completeness, 'complete');
assert.equal(section.toolStats.calls, 1);

const repairEvents = [];
const repairingSectionDriver = {
  count: 0,
  async decide({ prompt }) {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail', headingTitle: '尾部证据' }, publicRationale: '读取尾部章节原文。' };
    if (this.count === 2) {
      assert.match(prompt, /read_note_section arguments 只允许 headingId、cursor/);
      return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail' }, publicRationale: '按允许参数重新读取章节。' };
    }
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '已在纠正参数后读取到原文。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
  async synthesize({ prompt }) { return { type: 'answer', answer: '已在纠正参数后读取到原文。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' }; },
};
const repairedSection = await runCurrentNoteAgent(agentInput(repairingSectionDriver, new NoteConversationMemory(), {
  onToolEvent: (event) => repairEvents.push(event),
}));
assert.equal(repairedSection.completeness, 'complete');
assert.equal(repairedSection.evidence.length, 1);
assert.ok(repairEvents.some((event) => event.tool === 'read_note_section' && event.state === 'rejected'));
assert.ok(repairEvents.some((event) => event.tool === 'read_note_section' && event.state === 'completed'));

for (const invalidCursor of [0, 7]) {
  const cursorEvents = [];
  const cursorResetDriver = {
    count: 0,
    async decide({ prompt }) {
      this.count += 1;
      if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail', cursor: invalidCursor }, publicRationale: '读取尾部章节原文。' };
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return { type: 'answer', answer: '章节游标已由主进程安全归一化。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
    },
    async synthesize({ prompt }) { return { type: 'answer', answer: '章节游标已由主进程安全归一化。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' }; },
  };
  const cursorReset = await runCurrentNoteAgent(agentInput(cursorResetDriver, new NoteConversationMemory(), {
    onToolEvent: (event) => cursorEvents.push(event),
  }));
  assert.equal(cursorReset.completeness, 'complete');
  assert.equal(cursorReset.evidence[0]?.lineFrom, 5);
  assert.equal(cursorReset.toolStats.calls, 1);
  assert.ok(cursorEvents.some((event) => event.tool === 'read_note_section' && event.state === 'completed' && /章节游标已安全重置/u.test(event.message)));
  assert.ok(!cursorEvents.some((event) => event.tool === 'read_note_section' && event.state === 'rejected'));
}

const longSectionMarkdown = `# 长章节

${Array.from({ length: 220 }, (_, index) => `第 ${index + 1} 行用于验证章节分页游标。`).join('\n')}`;
const longSectionSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/long-section.md',
  title: '长章节夹具',
  contentHash: createHash('sha256').update(longSectionMarkdown, 'utf8').digest('hex'),
  markdown: longSectionMarkdown,
  headings: [{ id: 'long-section', level: 1, text: '长章节', line: 1 }],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
let issuedContinuationCursor;
const continuationEvents = [];
const continuationDriver = {
  count: 0,
  async decide({ prompt }) {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'long-section' }, publicRationale: '读取长章节第一页。' };
    if (this.count === 2) {
      const cursorMatch = prompt.match(/long-section=(\d+)/u);
      assert.ok(cursorMatch, 'next decision must expose the controller-issued section cursor');
      issuedContinuationCursor = Number(cursorMatch[1]);
      return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'long-section', cursor: issuedContinuationCursor }, publicRationale: '使用已返回游标继续读取。' };
    }
    const evidenceIds = [...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]);
    return { type: 'answer', answer: '章节已按主进程游标连续读取。', citations: evidenceIds, completeness: 'complete' };
  },
  async synthesize({ prompt }) { return { type: 'answer', answer: '章节已按主进程游标连续读取。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' }; },
};
const continuedSection = await runCurrentNoteAgent(agentInput(continuationDriver, new NoteConversationMemory(), {
  snapshot: longSectionSnapshot,
  question: '长章节后半部分是什么？',
  memoryScopeKey: 'window-1:long-section',
  onToolEvent: (event) => continuationEvents.push(event),
}));
assert.equal(continuedSection.completeness, 'complete');
assert.equal(continuedSection.evidence.length, 2);
assert.equal(continuedSection.evidence[1]?.lineFrom, issuedContinuationCursor);
const completedContinuationReads = continuationEvents.filter((event) => event.tool === 'read_note_section' && event.state === 'completed');
assert.equal(completedContinuationReads.length, 2);
assert.ok(completedContinuationReads.every((event) => !/章节游标已安全重置/u.test(event.message)));

const fallbackEvents = [];
const prematureNotFoundDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingTitle: '尾部证据' }, publicRationale: '读取尾部章节原文。' };
    return { type: 'answer', answer: '证据不足。', citations: [], completeness: 'not-found' };
  },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '自动降级检索后找到了尾部结论。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
};
const modelStoppedAfterToolCorrection = await runCurrentNoteAgent(agentInput(prematureNotFoundDriver, new NoteConversationMemory(), {
  onToolEvent: (event) => fallbackEvents.push(event),
}));
assert.equal(modelStoppedAfterToolCorrection.completeness, 'not-found');
assert.equal(modelStoppedAfterToolCorrection.answer, '证据不足。');
assert.equal(modelStoppedAfterToolCorrection.evidence.length, 0);
assert.equal(modelStoppedAfterToolCorrection.agentStats.stopReason, 'answered');
assert.equal(fallbackEvents.some((event) => event.tool === 'search_note' && event.state === 'completed'), false, 'a model answer must not trigger lexical recovery');
assert.equal(fallbackEvents.some((event) => event.tool === 'read_note_range' && event.state === 'completed'), false, 'a model answer must not trigger controller-owned reads');

const definitionMarkdown = `# 图谱说明

${'背景资料。'.repeat(260)}

## NER 模型

NER 是 Named Entity Recognition，中文叫“命名实体识别”。它的作用是从文本中找出有业务意义的实体，并判断实体类型。

## 4. LLM 抽取不是 NER

LLM 抽取不是传统 NER，而是直接输出结构化实体、关系和 Evidence。`;
const definitionSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/ner.md',
  title: 'NER 夹具',
  contentHash: createHash('sha256').update(definitionMarkdown, 'utf8').digest('hex'),
  markdown: definitionMarkdown,
  headings: [
    { id: 'graph-overview', level: 1, text: '图谱说明', line: 1 },
    { id: 'ner-model', level: 2, text: 'NER 模型', line: 5 },
    { id: 'llm-not-ner', level: 2, text: '4. LLM 抽取不是 NER', line: 9 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const definitionFallbackEvents = [];
const definitionFallbackDriver = {
  count: 0,
  async decide() {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_section', arguments: { headingTitle: 'NER 模型' }, publicRationale: '读取 NER 定义章节。' };
    return { type: 'answer', answer: '证据不足。', citations: [], completeness: 'not-found' };
  },
  async synthesize({ prompt }) {
    const evidenceIds = [...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]);
    return { type: 'answer', answer: 'NER 是命名实体识别。', citations: evidenceIds, completeness: 'complete' };
  },
};
const definitionModelStop = await runCurrentNoteAgent(agentInput(definitionFallbackDriver, new NoteConversationMemory(), {
  snapshot: definitionSnapshot,
  question: 'NER是啥？',
  memoryScopeKey: 'window-1:ner-definition',
  onToolEvent: (event) => definitionFallbackEvents.push(event),
}));
assert.equal(definitionModelStop.completeness, 'not-found');
assert.equal(definitionModelStop.answer, '证据不足。');
assert.equal(definitionModelStop.evidence.length, 0);
assert.equal(definitionFallbackEvents.filter((event) => event.tool === 'read_note_range' && event.state === 'completed').length, 0);
assert.equal(definitionFallbackEvents.some((event) => event.tool === 'search_note' && event.state === 'completed'), false, 'answer 后不得启动自动搜索');

const expandDriver = {
  count: 0,
  async decide({ prompt }) {
    this.count += 1;
    if (this.count === 1) return { type: 'tool', tool: 'read_note_range', arguments: { lineFrom: 7, lineTo: 7 }, publicRationale: '读取初始证据。' };
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    if (this.count === 2) return { type: 'tool', tool: 'expand_evidence', arguments: { evidenceId, beforeLines: 2, afterLines: 0 }, publicRationale: '补充前置上下文。' };
    const finalEvidenceId = [...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].at(-1)?.[0];
    return { type: 'answer', answer: '已补充前置上下文。', citations: finalEvidenceId ? [finalEvidenceId] : [], completeness: 'complete' };
  },
  async synthesize({ prompt }) { return { type: 'answer', answer: '已补充前置上下文。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' }; },
};
const expanded = await runCurrentNoteAgent(agentInput(expandDriver));
assert.equal(expanded.completeness, 'complete');
assert.equal(expanded.toolStats.calls, 2);

const controller = new AbortController();
let cancelledPlannerCalls = 0;
const cancelDriver = {
  async decide() { cancelledPlannerCalls += 1; return { type: 'tool', tool: 'search_note', arguments: { terms: ['尾部结论'] }, publicRationale: '定位证据。' }; },
  async synthesize() { throw new Error('cancelled flow must not synthesize'); },
};
await assert.rejects(
  () => runCurrentNoteAgent(agentInput(cancelDriver, new NoteConversationMemory(), {
    signal: controller.signal,
    onToolEvent: (event) => { if (event.state === 'started') controller.abort(); },
  })),
  /取消/,
);
assert.equal(cancelledPlannerCalls, 1);

assert.throws(() => parseCurrentNoteAgentAction({ type: 'tool', tool: 'shell', arguments: {}, publicRationale: '执行命令' }), /不允许的工具/);
assert.throws(() => parseCurrentNoteAgentAction({ type: 'tool', tool: 'search_note', arguments: {}, publicRationale: 'x'.repeat(81) }), /公开说明/);
const sanitizedSectionAction = parseCurrentNoteAgentAction({
  type: 'tool',
  tool: 'read_note_section',
  arguments: { headingId: 'tail', headingTitle: '尾部证据', query: 'NER' },
  publicRationale: '读取尾部章节。',
});
assert.deepEqual(sanitizedSectionAction.arguments, { headingId: 'tail' });
const normalizedStructuredPatchAction = parseCurrentNoteAgentAction({
  type: 'tool',
  goalId: 'goal-structured',
  tool: 'read_note_section',
  arguments: { headingId: 'tail', cursor: null },
  publicRationale: '验证 Structured Outputs 占位字段归一化。',
  planPatch: {
    baseVersion: 2,
    activeGoalId: 'goal-structured',
    goalOrder: ['goal-structured'],
    goalUpdates: [{
      goalId: 'goal-structured',
      status: null,
      queryVariants: [],
      evidenceBindings: null,
      conflictBindings: null,
      missingEvidence: null,
      clearMissingEvidence: false,
    }],
  },
});
assert.deepEqual(normalizedStructuredPatchAction.arguments, { headingId: 'tail' });
assert.deepEqual(normalizedStructuredPatchAction.planPatch, {
  baseVersion: 2,
  activeGoalId: 'goal-structured',
  goalOrder: ['goal-structured'],
  goalUpdates: [],
}, 'Structured Outputs 的 null/空 queryVariants 占位不得变成计划更新');
const clearMissingEvidenceAction = parseCurrentNoteAgentAction({
  type: 'answer',
  answer: '清除已补足的证据缺口。',
  citations: [],
  completeness: 'partial',
  planPatch: {
    baseVersion: 3,
    activeGoalId: 'goal-structured',
    goalOrder: ['goal-structured'],
    goalUpdates: [{
      goalId: 'goal-structured',
      status: null,
      queryVariants: null,
      evidenceBindings: null,
      conflictBindings: null,
      missingEvidence: null,
      clearMissingEvidence: true,
    }],
  },
});
assert.deepEqual(clearMissingEvidenceAction.planPatch?.goalUpdates, [{ goalId: 'goal-structured', missingEvidence: null }]);
const providerDriver = createStructuredActionDriver({
  async generateJson() { return { type: 'answer', answer: '结构化回答。', citations: [], completeness: 'not-found' }; },
});
assert.equal((await providerDriver.decide({ prompt: 'x', signal: new AbortController().signal })).type, 'answer');

let strictSchemaRequest;
const strictSchemaDriver = createStructuredActionDriver({
  async generateJson(request) {
    strictSchemaRequest = request;
    return { type: 'answer', answer: '严格结构化回答。', citations: [], completeness: 'not-found' };
  },
});
const strictSchema = { name: 'current_note_decide', strict: true, schema: { type: 'object', additionalProperties: false } };
await strictSchemaDriver.decide({ prompt: 'x', signal: new AbortController().signal, jsonSchema: strictSchema });
assert.equal(strictSchemaRequest?.jsonSchema, undefined, '当前笔记 ReAct 不得把严格 answer Schema 发送给 Provider');
assert.equal(typeof strictSchemaRequest?.onRawResponse, 'function', '当前笔记 ReAct 必须保留原始模型输出回传');
const timeoutStructuredDriver = createStructuredActionDriver({
  async generateJson() { throw new DOMException('provider aborted request', 'AbortError'); },
});
await assert.rejects(
  () => timeoutStructuredDriver.decide({ prompt: 'x', signal: new AbortController().signal }),
  (error) => error?.code === 'provider-timeout',
  'provider-side AbortError without user cancellation must be classified as provider-timeout',
);
const longRationaleDriver = createStructuredActionDriver({
  async generateJson() {
    return {
      type: 'tool',
      tool: 'read_note_section',
      arguments: { headingId: 'tail', cursor: null },
      publicRationale: '长'.repeat(81),
    };
  },
});
const longRationaleOutput = await longRationaleDriver.decide({ prompt: 'x', signal: new AbortController().signal });
assert.equal(longRationaleOutput.type, 'answer', '不可执行的工具动作必须直接作为模型最终输出，而不是被格式校验拒绝');
assert.match(longRationaleOutput.answer, /read_note_section/u);

let firstFormatPrompt = '';
let formatSynthesisPrompt = '';
let freeFormDecisionCount = 0;
const formatRepairDriver = createStructuredActionDriver({
  async generateJson({ prompt, callKind, onRawResponse }) {
    if (callKind === 'synthesize') {
      formatSynthesisPrompt = prompt;
      return { type: 'answer', answer: '已基于读取到的原文重新组织回答。', citations: evidenceIdsFromPrompt(prompt), completeness: 'complete' };
    }
    freeFormDecisionCount += 1;
    if (freeFormDecisionCount === 1) {
      firstFormatPrompt = prompt;
      return { type: 'tool', tool: 'read_note_section', arguments: { headingId: 'tail' }, publicRationale: '读取尾部章节原文。' };
    }
    onRawResponse?.('这是模型自由格式的最终回答。');
    throw new SyntaxError('invalid JSON from provider');
  },
});
const formatRepaired = await runCurrentNoteAgent(agentInput(formatRepairDriver, new NoteConversationMemory()));
assert.equal(formatRepaired.completeness, 'complete');
assert.equal(formatRepaired.evidence.length, 1, '有原文证据时最终回答必须由综合阶段产出引用');
assert.equal(formatRepaired.answer, '已基于读取到的原文重新组织回答。');
assert.equal(formatRepaired.agentStats.stopReason, 'answered');
assert.equal(freeFormDecisionCount, 2, '自由格式模型输出仍会结束检索，不进入纠错轮');
assert.match(formatSynthesisPrompt, /尾部唯一结论：受控 ReAct 必须读取原文后才能回答/u, '最终综合必须收到已读取的原文，而不是仅证据目录');
assert.match(firstFormatPrompt, /首次读取章节把 cursor 写为 null/u, '工具参数提示仍需保持可执行结构。');
assert.doesNotMatch(firstFormatPrompt, /首次读取章节必须省略 cursor/u);

const p3Sources = await Promise.all([
  fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts'), 'utf8'),
  fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'currentNoteEvidenceLedger.ts'), 'utf8'),
  fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'structuredActionDriver.ts'), 'utf8'),
]);
for (const source of p3Sources) {
  for (const forbidden of ['searchEmbeddedSemantically', 'sqlite-vec', 'sqliteVec', 'embeddingModel']) {
    assert.equal(source.includes(forbidden), false, `P3 must not depend on ${forbidden}`);
  }
}
const mainSource = await fs.readFile(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const panelSource = await fs.readFile(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
assert.match(mainSource, /runCurrentNoteAgent\([\s\S]{0,1200}createStructuredActionDriver/);
assert.match(mainSource, /runCurrentNoteAgent\([\s\S]{0,400}answerDepth: request\.answerDepth/);
assert.match(mainSource, /contextMode: agentResult\.contextMode,[\s\S]{0,300}toolStats: agentResult\.toolStats/);
assert.match(mainSource, /toolEvents\.push\(\{ \.\.\.toolEvent \}\)/);
assert.match(mainSource, /route: 'current-note-react',[\s\S]{0,120}agentMessages: agentResult\.agentMessages/, 'WK-M9 后工具原子历史写入 canonical qa turn');
const currentNoteReactMainSource = mainSource.slice(mainSource.indexOf('const useCurrentNoteAgent'), mainSource.indexOf("emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在生成回答…'"));
assert.doesNotMatch(currentNoteReactMainSource, /scopedMemoryRepository\.finalizeTurn\(persistedTurn\.turnId/, 'WK-M9 后不得继续双写旧 current-note ReAct turn');
assert.match(mainSource, /'read_current_note',[\s\S]{0,500}不会检索笔记库中的其他笔记/);
assert.match(mainSource, /toolCallsAlreadyUsed: toolEvents\.filter\(\(toolEvent\) => toolEvent\.state !== 'started'\)\.length/);
assert.match(mainSource, /resolveAssistantAnswerContext\(\s*libraryPath,\s*request,\s*controller\.signal,\s*assistantMineru,\s*onToolEvent,\s*onDetailedTrace\s*[,)]/);
assert.match(mainSource, /const isDevelopment = !app\.isPackaged && process\.env\.NODE_ENV !== 'production';[\s\S]{0,180}const expectedUrl = isDevelopment/);
assert.match(panelSource, /event\.type === 'tool'[\s\S]{0,220}toolEvents: \[\.\.\.\(message\.toolEvents \?\? \[\]\), event\.event\]/);
assert.match(panelSource, /function AssistantToolTrace\(/);
const assistantMessageViewStart = panelSource.indexOf('function AssistantMessageView');
const assistantThinkingTraceStart = panelSource.indexOf('function AssistantThinkingTrace');
const assistantMessageViewSource = panelSource.slice(assistantMessageViewStart, assistantThinkingTraceStart);
assert.ok(assistantMessageViewStart >= 0 && assistantThinkingTraceStart > assistantMessageViewStart);
assert.ok(
  assistantMessageViewSource.indexOf('<AssistantToolTrace') < assistantMessageViewSource.indexOf('<AssistantThinkingTrace'),
  '工具运行过程应显示在深度思考之前',
);
assert.match(panelSource, /id: 'ask',[\s\S]{0,80}scope: 'current-note'/);
assert.match(panelSource, /回答范围固定为当前打开的笔记/);
assert.match(panelSource, /function AssistantContextWindowUsage\(/);
assert.doesNotMatch(panelSource, /本次上下文与范围/);

console.log('Current-note ReAct P3 verification passed');
