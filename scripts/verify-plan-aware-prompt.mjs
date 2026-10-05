import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-plan-aware-prompt');
const prebuiltDir = process.env.PLAN_AWARE_PROMPT_PREBUILT_DIR?.trim();
const projectorFile = prebuiltDir
  ? path.resolve(prebuiltDir, 'projector-stage2-check.mjs')
  : path.join(outDir, 'projector.cjs');
const traceFile = prebuiltDir
  ? path.resolve(prebuiltDir, 'trace-stage2-check.mjs')
  : path.join(outDir, 'trace.cjs');
if (!prebuiltDir) {
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planAwarePromptProjector.ts')], outfile: projectorFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planExecutionTraceStore.ts')], outfile: traceFile, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}

const { PlanAwarePromptProjector, createCurrentNoteDecideJsonSchema, DEFAULT_CITATION_REPAIR_JSON_SCHEMA, DEFAULT_DECIDE_JSON_SCHEMA, DEFAULT_PLAN_JSON_SCHEMA, DEFAULT_SYNTHESIZE_JSON_SCHEMA } = await import(pathToFileURL(projectorFile).href);
const { PlanExecutionTraceStore } = await import(pathToFileURL(traceFile).href);

const decideSchema = JSON.parse(DEFAULT_DECIDE_JSON_SCHEMA);
const conversationSearchSchema = JSON.parse(createCurrentNoteDecideJsonSchema(true));
const synthesizeSchema = JSON.parse(DEFAULT_SYNTHESIZE_JSON_SCHEMA);
assert.equal(decideSchema.properties.tool.anyOf[0].enum.includes('search_conversations'), false, '未绑定 M6 runtime 时不得向模型暴露历史对话工具');
assert.equal(conversationSearchSchema.properties.tool.anyOf[0].enum.includes('search_conversations'), true, '绑定 M6 runtime 后必须动态暴露历史对话工具');
assert.ok(decideSchema.properties?.type?.enum?.includes('tool') && decideSchema.properties?.type?.enum?.includes('answer'), 'decide schema must declare tool and answer actions');
assert.ok(decideSchema.properties?.tool && decideSchema.properties?.arguments && decideSchema.properties?.publicRationale, 'decide schema must declare tool action fields');
assert.ok(decideSchema.properties?.answer && decideSchema.properties?.citations && decideSchema.properties?.completeness, 'decide schema must declare answer action fields');
assert.ok(decideSchema.properties?.planPatch, 'decide schema must declare planPatch');
assert.ok(synthesizeSchema.properties?.planPatch, 'synthesize schema must declare the final planPatch');
assert.ok(decideSchema.properties.planPatch.anyOf?.[0].properties.goalUpdates.items.properties.evidenceBindings, 'planPatch must declare requirement evidenceBindings');
const structuredGoalUpdateSchema = decideSchema.properties.planPatch.anyOf[0].properties.goalUpdates.items;
assert.equal(structuredGoalUpdateSchema.properties.queryVariants.anyOf[0].minItems, 1, 'Structured Outputs must reject empty queryVariants arrays');
assert.equal(structuredGoalUpdateSchema.properties.queryVariants.anyOf[0].maxItems, 4, 'Structured Outputs must enforce the per-patch queryVariants limit');
assert.ok(structuredGoalUpdateSchema.required.includes('clearMissingEvidence'), 'Structured Outputs must disambiguate missingEvidence null from an explicit clear');
assert.match(decideSchema.properties.planPatch.description, /没有任何实际变化时必须返回 null/u);

const evidenceA = `evidence-${'a'.repeat(24)}`;
const evidenceB = `evidence-${'b'.repeat(24)}`;
const evidenceUnbound = `evidence-${'c'.repeat(24)}`;
const evidence = [
  { evidenceId: evidenceA, noteId: 'note-a', lineFrom: 10, lineTo: 12, text: '原文支持：甲方案具备离线能力。', contentHash: 'hash-a' },
  { evidenceId: evidenceB, noteId: 'note-a', lineFrom: 20, lineTo: 22, text: '原文反证：乙方案需要联网。', contentHash: 'hash-b' },
  { evidenceId: evidenceUnbound, noteId: 'note-b', lineFrom: 1, lineTo: 2, text: '完整搜索轨迹不应进入最终合成。', contentHash: 'hash-c' },
];
const plan = {
  planId: 'plan-stage2',
  version: 3,
  originalQuestion: '比较两种方案。',
  activeGoalId: 'goal-compare',
  status: 'active',
  revisionCount: 1,
  goalUpdateCount: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  goals: [{
    goalId: 'goal-compare',
    question: '比较两种方案。',
    evidenceKind: 'comparison',
    requirements: [{ requirementId: 'req-compare', label: '需要双方原文', subject: '甲乙', minEvidence: 1 }],
    queryTerms: [{ term: '方案', source: 'planner' }],
    status: 'partial',
    evidenceBindings: [{ requirementId: 'req-compare', evidenceIds: [evidenceA] }],
    conflictBindings: [{ requirementId: 'req-compare', supportsEvidenceIds: [evidenceA], contradictsEvidenceIds: [evidenceB] }],
  }],
};

const traceStore = new PlanExecutionTraceStore();
traceStore.record({ planId: plan.planId, planVersion: 3, goalId: 'goal-compare', kind: 'action', tool: 'search_note', summary: '已请求导航搜索', evidenceIds: [] });
traceStore.record({ planId: plan.planId, planVersion: 3, goalId: 'goal-compare', kind: 'observation', tool: 'read_note_range', summary: '已写入 Evidence Ledger', evidenceIds: [evidenceA] });
traceStore.record({ planId: plan.planId, planVersion: 3, goalId: 'goal-compare', kind: 'observation', tool: 'read_note_range', summary: '已写入 Evidence Ledger', evidenceIds: [evidenceA] });
const l1 = traceStore.compactL1({ planId: plan.planId, planVersion: 3, activeGoalId: plan.activeGoalId });
assert.equal(l1.length, 2, 'L1 folds duplicate observations deterministically');
assert.equal(l1.find((entry) => entry.kind === 'observation')?.count, 2);
assert.deepEqual(l1.find((entry) => entry.kind === 'observation')?.evidenceIds, [evidenceA]);

const projector = new PlanAwarePromptProjector(traceStore);
const decide = projector.build({
  callKind: 'decide',
  stablePrefix: '[固定策略] 只依据当前作用域。',
  question: '比较两种方案。',
  conversation: [{ role: 'user', content: '请比较两种方案。' }],
  plan,
  evidence,
  outputSchema: DEFAULT_DECIDE_JSON_SCHEMA,
});
assert.match(decide.prompt, /planId=plan-stage2/);
assert.match(decide.prompt, /planVersion=3/);
assert.match(decide.prompt, /baseVersion=3/);
assert.match(decide.prompt, /activeGoalId=goal-compare/);
assert.match(decide.prompt, /req-compare/);
assert.match(decide.prompt, /evidenceId=evidence-aaaaaaaaaaaaaaaaaaaaaaaa/);
assert.doesNotMatch(decide.prompt, /原文支持：甲方案具备离线能力/u, 'decide never receives raw evidence text');
assert.doesNotMatch(decide.prompt, /完整搜索轨迹不应进入最终合成/u);

const evidenceLong = `evidence-${'d'.repeat(24)}`;
const longObservationText = `${'阶段二最新证据预览。'.repeat(180)}LATEST_OBSERVATION_TAIL_MUST_BE_TRUNCATED`;
const observedEvidence = [
  { ...evidence[0], admission: 'explicit-read', admissions: ['explicit-read'], headingPath: ['方案比较', '甲方案'], firstSeenSeq: 1 },
  evidence[1],
  {
    evidenceId: evidenceLong,
    noteId: 'note-a',
    lineFrom: 30,
    lineTo: 48,
    text: longObservationText,
    contentHash: 'hash-d',
    admission: 'explicit-read',
    admissions: ['explicit-read'],
    headingPath: ['方案比较', '长证据'],
    firstSeenSeq: 2,
  },
];
const decideWithLatestEvidence = projector.build({
  callKind: 'decide',
  stablePrefix: '[固定策略] 最新证据只用于下一步决策。',
  question: '比较两种方案。',
  plan,
  evidence: observedEvidence,
  recentEvidenceIds: [evidenceA, evidenceLong],
  latestEvidenceObservations: [
    { goalId: 'goal-compare', evidenceId: evidenceA, hasNextCursor: false },
    { goalId: 'goal-compare', evidenceId: evidenceLong, hasNextCursor: true, nextCursor: 49 },
  ],
  outputSchema: DEFAULT_DECIDE_JSON_SCHEMA,
});
assert.match(decideWithLatestEvidence.prompt, /latest-evidence-observation decision-only/u);
assert.match(decideWithLatestEvidence.prompt, /原文支持：甲方案具备离线能力/u, 'Decision must receive the latest explicit-read source preview');
assert.match(decideWithLatestEvidence.prompt, /section=方案比较 \/ 甲方案 L10-12 hasNextCursor=false nextCursor=none/u);
assert.match(decideWithLatestEvidence.prompt, /hasNextCursor=true nextCursor=49/u);
assert.doesNotMatch(decideWithLatestEvidence.prompt, /LATEST_OBSERVATION_TAIL_MUST_BE_TRUNCATED/u, 'large Decision observations must stay bounded');
assert.match(decideWithLatestEvidence.prompt, /不代表最终 citations 或 evidenceBindings/u);

const pressureDecide = projector.build({
  callKind: 'decide',
  stablePrefix: '[固定策略] 高压力下仍保留读取成功信号。',
  question: '比较两种方案。',
  plan,
  evidence: observedEvidence,
  latestEvidenceObservations: [{ goalId: 'goal-compare', evidenceId: evidenceLong, hasNextCursor: true, nextCursor: 49 }],
  projectionLevel: 4,
  outputSchema: DEFAULT_DECIDE_JSON_SCHEMA,
});
const pressureObservation = pressureDecide.segments.find((segment) => segment.id === 'latest-evidence-observation');
assert.equal(pressureObservation?.protected, true, 'highest-pressure Decision must keep a protected latest-read signal');
assert.match(pressureDecide.prompt, /latest-evidence-observation decision-only/u);
assert.match(pressureDecide.prompt, /evidence-dddddddddddddddddddddddd/u);
assert.throws(() => projector.build({
  callKind: 'decide',
  stablePrefix: '[固定策略]',
  question: '比较两种方案。',
  plan,
  evidence: observedEvidence,
  latestEvidenceObservations: [{ goalId: 'goal-other', evidenceId: evidenceA, hasNextCursor: false }],
  outputSchema: DEFAULT_DECIDE_JSON_SCHEMA,
}), /非当前 active goal/u, 'Decision observations must not cross goal boundaries');

const planProjection = projector.build({
  callKind: 'plan',
  stablePrefix: '[Planner 固定策略]',
  capsuleText: 'noteCapsule: 章节目录',
  question: '比较两种方案。',
  outputSchema: DEFAULT_PLAN_JSON_SCHEMA,
});
assert.doesNotMatch(planProjection.prompt, /planId=/u, 'initial plan has no synthetic plan identity');
assert.match(planProjection.prompt, /JSON Schema/);

const beforePlan = JSON.stringify(plan);
const synth = projector.build({
  callKind: 'synthesize',
  stablePrefix: '[固定策略] 只依据 Evidence Ledger。',
  question: '比较两种方案。',
  plan,
  evidence,
  traceStore,
  outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
});
assert.match(synth.prompt, /原文支持：甲方案具备离线能力/u);
assert.match(synth.prompt, /原文反证：乙方案需要联网/u);
assert.doesNotMatch(synth.prompt, /完整搜索轨迹不应进入最终合成/u, 'synthesis excludes unbound evidence');
assert.doesNotMatch(synth.prompt, /已请求导航搜索/u, 'synthesis excludes execution trace');
assert.equal(JSON.stringify(plan), beforePlan, 'projector does not mutate SearchPlan');

const candidateSynth = projector.build({
  callKind: 'synthesize',
  stablePrefix: '[固定策略] 单目标候选只来自本轮原文读取。',
  question: '核实单目标原文。',
  plan,
  evidence,
  candidateEvidenceIds: [evidenceUnbound],
  outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
});
assert.match(candidateSynth.prompt, /完整搜索轨迹不应进入最终合成/u, 'single-goal synthesis receives the controller-selected candidate raw text');
assert.doesNotMatch(candidateSynth.prompt, /原文支持：甲方案具备离线能力/u, 'candidate synthesis excludes unrelated bound evidence');
assert.doesNotMatch(candidateSynth.prompt, /原文反证：乙方案需要联网/u, 'candidate synthesis excludes conflict evidence outside the candidate set');

const allRetrievedSynth = projector.build({
  callKind: 'synthesize',
  stablePrefix: '[固定策略] 全量已检索证据。',
  question: '比较两种方案。',
  plan,
  evidence: evidence.map((record, index) => ({ ...record, firstSeenSeq: index + 1, admission: index === 0 ? 'search-hit' : 'explicit-read' })),
  candidateEvidenceIds: [evidenceA],
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'off',
  maxPromptTokens: 10_000,
  snapshotId: 'snapshot-plan-aware',
  contentHash: 'hash-plan-aware',
  outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
});
assert.ok(allRetrievedSynth.evidencePromptManifest, 'all-retrieved + off must produce an exact Manifest');
assert.equal(allRetrievedSynth.evidencePromptManifest.representationCoverage, 1);
assert.deepEqual(allRetrievedSynth.evidencePromptManifest.missingEvidenceIds, []);
assert.equal(allRetrievedSynth.evidencePromptManifest.rawEvidenceIds.length, evidence.length);
assert.match(allRetrievedSynth.prompt, /\[raw-evidence\]/u);
assert.match(allRetrievedSynth.prompt, /完整搜索轨迹不应进入最终合成/u, 'unbound retrieved evidence must remain visible');
assert.match(allRetrievedSynth.prompt, /原文支持：甲方案具备离线能力/u);
assert.match(allRetrievedSynth.prompt, /原文反证：乙方案需要联网/u);

const repair = projector.build({
  callKind: 'citation-repair',
  stablePrefix: '[固定策略]',
  question: '修复引用。',
  plan,
  evidence,
  answer: '答案草稿',
  citationError: '引用不在允许集合。',
  allowedEvidenceIds: [evidenceA, evidenceB],
  outputSchema: DEFAULT_CITATION_REPAIR_JSON_SCHEMA,
});
assert.match(repair.prompt, /allowedEvidenceIds=evidence-aaaaaaaaaaaaaaaaaaaaaaaa,evidence-bbbbbbbbbbbbbbbbbbbbbbbb/u);
assert.doesNotMatch(repair.prompt, /完整搜索轨迹不应进入最终合成/u);

console.log('Plan-aware prompt verification passed');
