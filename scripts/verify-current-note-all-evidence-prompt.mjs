import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-all-evidence-prompt');
await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planAwarePromptProjector.ts')],
    outfile: path.join(outDir, 'projector.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallCoordinator.ts')],
    outfile: path.join(outDir, 'coordinator.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallBudget.ts')],
    outfile: path.join(outDir, 'model-budget.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
]);

const { PlanAwarePromptProjector, DEFAULT_SYNTHESIZE_JSON_SCHEMA } = await import(pathToFileURL(path.join(outDir, 'projector.cjs')).href);
const { ModelCallCoordinator } = await import(pathToFileURL(path.join(outDir, 'coordinator.cjs')).href);
const { ModelCallBudgetGate } = await import(pathToFileURL(path.join(outDir, 'model-budget.cjs')).href);

const snapshotId = 'snapshot-stage3';
const contentHash = 'content-hash-stage3';
const projector = new PlanAwarePromptProjector();
const counts = [10, 20, 50];
const reports = [];

for (const count of counts) {
  const evidence = Array.from({ length: count }, (_, index) => ({
    evidenceId: `evidence-${String(index + 1).padStart(24, '0')}`,
    text: index < 2
      ? `EvidenceAnchor ${index + 1}：第 ${index + 1} 条当前快照原文，属于冲突校验绑定。`
      : `EvidenceAnchor ${index + 1}：第 ${index + 1} 条当前快照原文，属于未绑定目标的已检索证据。`,
    snapshotId,
    contentHash,
    noteId: 'stage3-note',
    lineFrom: index * 2 + 1,
    lineTo: index * 2 + 1,
    firstSeenSeq: index + 1,
    admission: index % 2 === 0 ? 'search-hit' : 'explicit-read',
  })).reverse();
  const firstId = evidence.at(-1).evidenceId;
  const secondId = evidence.at(-2).evidenceId;
  const plan = createPlan(firstId, secondId);
  const maxPromptTokens = 100_000;
  const projection = projector.build({
    callKind: 'synthesize',
    stablePrefix: '[固定策略] 只依据当前快照证据。',
    question: '比较两个目标并保留冲突双方。',
    plan,
    evidence,
    candidateEvidenceIds: [firstId],
    assistantEvidenceProjectionMode: 'all-retrieved',
    evidenceCompressionMode: 'off',
    maxPromptTokens,
    snapshotId,
    contentHash,
    outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
    rulesText: '最终合成基于全部已检索证据。',
  });
  const manifest = projection.evidencePromptManifest;
  assert.ok(manifest, `count=${count} must create a Manifest`);
  assert.equal(manifest.snapshotId, snapshotId);
  assert.equal(manifest.contentHash, contentHash);
  assert.equal(manifest.turnRetrievedEvidenceIds.length, count);
  assert.equal(manifest.rawEvidenceIds.length, count);
  assert.equal(manifest.representedEvidenceIds.length, count);
  assert.deepEqual(
    manifest.turnRetrievedEvidenceIds,
    Array.from({ length: count }, (_, index) => `evidence-${String(index + 1).padStart(24, '0')}`),
    `count=${count} evidence order must use firstSeenSeq before source position`,
  );
  assert.deepEqual(manifest.missingEvidenceIds, []);
  assert.equal(manifest.representationCoverage, 1);
  assert.equal(manifest.compressionRounds, 0);
  assert.equal(manifest.compressionBatchCount, 0);
  assert.ok(manifest.rawTokens <= manifest.evidenceBudgetTokens, `count=${count} raw evidence must fit its payload budget`);
  for (const record of evidence) assert.match(projection.prompt, new RegExp(record.evidenceId, 'u'));
  assert.match(projection.prompt, /\[raw-evidence\]/u);
  assert.match(projection.prompt, /evidence-manifest/u);
  assert.match(projection.prompt, /未绑定目标的已检索证据/u);
  assert.ok(projection.promptStats.predictedPromptTokens <= maxPromptTokens, `count=${count} predicted prompt must fit`);

  const gate = new ModelCallBudgetGate({ maxModelCalls: 2, maxWallTimeMs: 10_000 });
  const coordinator = new ModelCallCoordinator(gate, maxPromptTokens);
  const prepared = coordinator.prepare({
    callKind: 'synthesize',
    prompt: projection.prompt,
    evidencePromptManifest: manifest,
  });
  assert.equal(prepared.ready, true, `count=${count} final send gate must accept 100% Manifest coverage`);
  assert.ok(prepared.call.plan.predictedPromptTokens <= prepared.call.plan.maxPromptTokens, `count=${count} complete prompt must fit the coordinator budget`);
  assert.equal(gate.modelCalls, 1);

  const observed = projector.build({
    callKind: 'synthesize',
    stablePrefix: '[固定策略] 只依据当前快照证据。',
    question: '比较两个目标并保留冲突双方。',
    plan,
    evidence,
    assistantEvidenceProjectionMode: 'all-retrieved',
    evidenceCompressionMode: 'observe',
    maxPromptTokens,
    snapshotId,
    contentHash,
    outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
  });
  assert.equal(observed.evidencePromptManifest, undefined, 'observe must not claim an exact Manifest');
  assert.doesNotMatch(observed.prompt, /\[raw-evidence\]/u, 'observe must keep the existing minimal Prompt path');
  assert.doesNotMatch(observed.prompt, /未绑定目标的已检索证据/u, 'observe must not broaden actual Prompt');

  reports.push({ count, rawTokens: manifest.rawTokens, evidenceBudgetTokens: manifest.evidenceBudgetTokens, predictedPromptTokens: projection.promptStats.predictedPromptTokens });
}

const schema = JSON.parse(DEFAULT_SYNTHESIZE_JSON_SCHEMA);
assert.equal(schema.additionalProperties, false, 'strict Synthesize Schema must remain closed');
console.log(JSON.stringify({ ok: true, counts: reports }, null, 2));

function createPlan(firstEvidenceId, secondEvidenceId) {
  return {
    planId: 'plan-stage3',
    version: 1,
    originalQuestion: '比较两个目标并保留冲突双方。',
    activeGoalId: 'goal-a',
    status: 'active',
    revisionCount: 0,
    goalUpdateCount: 0,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    goals: [
      {
        goalId: 'goal-a',
        question: '核对目标 A。',
        evidenceKind: 'fact',
        requirements: [{ requirementId: 'req-a', label: '目标 A 原文', minEvidence: 1 }],
        queryTerms: [{ term: '目标A', source: 'planner' }],
        status: 'covered',
        evidenceBindings: [{ requirementId: 'req-a', evidenceIds: [firstEvidenceId] }],
        conflictBindings: [],
      },
      {
        goalId: 'goal-b',
        question: '核对目标 B。',
        evidenceKind: 'comparison',
        requirements: [{ requirementId: 'req-b', label: '目标 B 冲突双方', minEvidence: 1 }],
        queryTerms: [{ term: '目标B', source: 'planner' }],
        status: 'conflicted',
        evidenceBindings: [],
        conflictBindings: [{ requirementId: 'req-b', supportsEvidenceIds: [firstEvidenceId], contradictsEvidenceIds: [secondEvidenceId] }],
      },
    ],
  };
}
