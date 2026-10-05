import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const scenario = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'scenario.json'), 'utf8'));
const notePath = path.join(fixtureDir, 'notes', 'all-evidence-baseline.md');
const stagingDir = path.join(rootDir, '.package-staging', `verify-current-note-broad-coverage-${process.pid}-${Date.now()}`);
fs.mkdirSync(stagingDir, { recursive: true });

await Promise.all([
  bundle('electron/knowledge/currentNoteAgentGraph.ts', 'graph.cjs'),
  bundle('electron/knowledge/searchPlanValidation.ts', 'validation.cjs'),
  bundle('electron/knowledge/currentNoteSnapshot.ts', 'snapshot.cjs'),
  bundle('electron/knowledge/noteConversationMemory.ts', 'memory.cjs'),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(path.join(stagingDir, 'graph.cjs')).href);
const {
  applySearchPlanAnswerAction,
  createSearchPlan,
  setSearchPlanControllerStatus,
} = await import(pathToFileURL(path.join(stagingDir, 'validation.cjs')).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(path.join(stagingDir, 'snapshot.cjs')).href);
const { NoteConversationMemory } = await import(pathToFileURL(path.join(stagingDir, 'memory.cjs')).href);

assert.deepEqual(
  scenario.phase6BroadCoverage.stateTable.map((row) => row.id),
  [
    'never-searched',
    'searched-without-evidence',
    'exhausted-without-evidence',
    'covered-with-one-citation',
    'conflicted-with-both-sides',
    'invalid-citation',
    'incomplete-representation',
  ],
  '阶段 3.5 状态表必须逐行保留在 fixture 中',
);
assert.equal(scenario.phase6BroadCoverage.relaxedRequirementMinEvidence, 1);
assert.equal(scenario.phase6BroadCoverage.conflictedRequiresBothSides, true);

const markdown = fs.readFileSync(notePath, 'utf8');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: '阶段 6 全量覆盖',
  contentHash: sha256(markdown),
  markdown,
  headings: headingsFromMarkdown(markdown),
  revision: 1,
});

let decisionCount = 0;

const result = await runCurrentNoteAgent({
  snapshot,
  question: '请核对全量已检索原文。',
  conversation: [],
  providerKind: 'ollama',
  model: 'stage6-fixture-model',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  planMode: 'off',
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'enforce',
  driver: {
    async decide({ prompt }) {
      decisionCount += 1;
      if (decisionCount === 1) {
        return { type: 'tool', tool: 'search_note', arguments: { terms: ['evidenceanchor'], limit: 8 }, publicRationale: '执行全量证据搜索。' };
      }
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      assert.ok(evidenceId, '最终动作必须引用当前 Evidence Ledger 的原文 ID');
      return {
        type: 'answer',
        answer: '全量覆盖夹具答案。',
        citations: [evidenceId],
        completeness: 'complete',
      };
    },
    async synthesize() {
      throw new Error('阶段 6 覆盖夹具不应因旧 minEvidence 门槛再次进入 Decide/Synthesize 循环。');
    },
  },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'stage6-broad-coverage',
  isSnapshotCurrent: () => true,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxDecisionRounds: 3, maxModelCalls: 8 },
});

assert.equal(result.completeness, 'complete', `all-retrieved + enforce 的模型答案应直接完成：${JSON.stringify({ completeness: result.completeness, answer: result.answer, evidence: result.evidence, agentStats: result.agentStats })}`);
assert.ok(result.evidence.length > 0, '全量检索至少应保留一条当前快照原文记录');

const evidenceIds = ['evidence-stage6-a', 'evidence-stage6-b', 'evidence-stage6-c'];
const strictPlan = createSearchPlan({
  originalQuestion: '阶段 6 状态表',
  goals: [
    {
      goalId: 'goal-covered',
      question: '覆盖目标',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'req-covered', label: '覆盖证据', minEvidence: 2 }],
      queryTerms: ['覆盖目标'],
    },
    {
      goalId: 'goal-conflict',
      question: '冲突目标',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'req-conflict', label: '冲突双方', minEvidence: 2, subject: '双方' }],
      queryTerms: ['冲突目标'],
    },
  ],
  now: '2026-08-24T00:00:00.000Z',
});
const activePlan = {
  ...strictPlan,
  goals: strictPlan.goals.map((goal) => ({ ...goal, status: 'searching' })),
  activeGoalId: 'goal-covered',
};
const completeAction = {
  type: 'answer',
  answer: '覆盖与冲突均已引用。',
  citations: evidenceIds,
  completeness: 'complete',
  planPatch: {
    baseVersion: activePlan.version,
    activeGoalId: null,
    goalUpdates: [
      { goalId: 'goal-covered', status: 'covered', evidenceBindings: [{ requirementId: 'req-covered', evidenceIds: [evidenceIds[0]] }], conflictBindings: [], missingEvidence: null },
      { goalId: 'goal-conflict', status: 'conflicted', evidenceBindings: [], conflictBindings: [{ requirementId: 'req-conflict', supportsEvidenceIds: [evidenceIds[1]], contradictsEvidenceIds: [evidenceIds[2]] }], missingEvidence: null },
    ],
  },
};

const strictResult = applySearchPlanAnswerAction(activePlan, completeAction, { evidenceIds: new Set(evidenceIds) });
assert.equal(strictResult.ok, false, 'minimal 旧校验仍必须拒绝不足原始 minEvidence 的 complete');
const broadResult = applySearchPlanAnswerAction(activePlan, completeAction, {
  evidenceIds: new Set(evidenceIds),
  relaxRequirementMinEvidence: true,
  allowConflictedComplete: true,
});
assert.equal(broadResult.ok, true, 'all-retrieved 终态应接受多目标合法绑定而不把 requirement 数量当作 Prompt allowlist');
if (broadResult.ok) {
  const completed = setSearchPlanControllerStatus(broadResult.plan, 'completed', {
    relaxRequirementMinEvidence: true,
    allowConflictedComplete: true,
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.goals.map((goal) => goal.status), ['covered', 'conflicted']);
}

console.log(JSON.stringify({
  ok: true,
  stateTableRows: scenario.phase6BroadCoverage.stateTable.length,
  broadAgentCompleteness: result.completeness,
  broadEvidenceCount: result.evidence.length,
  strictMinEvidenceRejected: strictResult.ok === false,
  multiGoalStatuses: broadResult.ok ? broadResult.plan.goals.map((goal) => goal.status) : [],
}, null, 2));

async function bundle(entryPoint, fileName) {
  await build({
    entryPoints: [path.join(rootDir, entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(stagingDir, fileName),
    logLevel: 'silent',
  });
}

function headingsFromMarkdown(value) {
  return value.split('\n').flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/u.exec(line);
    return match ? [{ id: `heading-${index + 1}`, level: match[1].length, text: match[2], line: index + 1 }] : [];
  });
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
