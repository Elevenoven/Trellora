import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-evidence-compression-budget');
const files = {
  planner: path.join(outDir, 'planner.cjs'),
  cache: path.join(outDir, 'cache.cjs'),
  coordinator: path.join(outDir, 'coordinator.cjs'),
  budget: path.join(outDir, 'budget.cjs'),
};
await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'evidenceCompressionPlanner.ts')], outfile: files.planner, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'evidenceCompressionCache.ts')], outfile: files.cache, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallCoordinator.ts')], outfile: files.coordinator, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallBudget.ts')], outfile: files.budget, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
]);

const { planEvidenceCompressionBatches } = await import(pathToFileURL(files.planner).href);
const { EvidenceCompressionCache } = await import(pathToFileURL(files.cache).href);
const { ModelCallCoordinator } = await import(pathToFileURL(files.coordinator).href);
const { ModelCallBudgetGate } = await import(pathToFileURL(files.budget).href);

const snapshotId = 'snapshot-stage4-budget';
const contentHash = 'content-hash-stage4-budget';
const evidence = Array.from({ length: 8 }, (_, index) => ({
  evidenceId: `evidence-${index + 1}`,
  snapshotId,
  contentHash,
  textHash: `text-hash-${index + 1}`,
  text: '甲'.repeat(100),
  headingPath: [index === 3 ? '第二节' : '第一节'],
  lineFrom: index + 1,
  lineTo: index + 1,
  goalIds: [index >= 4 ? 'goal-b' : 'goal-a'],
  firstSeenSeq: index + 1,
  bestScore: 1 - index / 10,
}));
const plannerInput = {
  snapshotId,
  contentHash,
  evidence,
  overflowTokens: 200,
  artifactFramingTokens: 0,
  maxSourceTokensPerBatch: 250,
  targetReductionRatio: 0.35,
  protectedEvidenceIds: ['evidence-8'],
};
const batches = planEvidenceCompressionBatches(plannerInput);
const reversedBatches = planEvidenceCompressionBatches({ ...plannerInput, evidence: [...evidence].reverse() });
assert.ok(batches.length >= 2, 'overflow must produce multiple independent batches');
assert.deepEqual(batches, reversedBatches, 'batch planning must be deterministic regardless of hit order');
assert.ok(batches.every((batch) => !batch.sourceEvidenceIds.includes('evidence-8')));
assert.ok(batches.every((batch) => batch.targetReductionRatio === 0.35));
assert.ok(batches.every((batch) => batch.estimatedCompressedTokens / batch.sourceTokenCount === 0.65));
assert.ok(batches.every((batch) => new Set(batch.sourceEvidenceIds.map((id) => evidence.find((record) => record.evidenceId === id)?.goalIds[0])).size === 1), 'a batch must not mix goals');
assert.ok(batches.every((batch) => batch.estimatedNetSavingsTokens > 0));

const stateVector = {
  libraryId: 'library-stage4',
  noteId: 'note-stage4',
  sessionId: 'session-stage4',
  turnId: 'turn-1',
  planId: 'plan-stage4',
  planVersion: 2,
  questionHash: 'question-hash-stage4',
  snapshotId,
  contentHash,
  sourceEvidenceIds: [...batches[0].sourceEvidenceIds],
  sourceTextHashes: Object.fromEntries(batches[0].sourceEvidenceIds.map((id) => [id, evidence.find((record) => record.evidenceId === id).textHash])),
  compressionPolicyVersion: 'stage4-v1',
  targetReductionRatio: 0.35,
  modelProfileId: 'profile-stage4',
  tokenizerFingerprint: 'estimator-v2',
};
const cachedArtifact = createArtifact(batches[0]);
const cache = new EvidenceCompressionCache();
const cacheKey = cache.set(stateVector, cachedArtifact);
const hit = cache.get(stateVector);
assert.equal(cacheKey.startsWith('evidence-compression-cache-'), true);
assert.deepEqual(hit, cachedArtifact);
hit.compressedSegments[0].text = '外部修改不应污染缓存';
assert.notEqual(cache.get(stateVector).compressedSegments[0].text, hit.compressedSegments[0].text);
for (const changed of [
  { ...stateVector, snapshotId: 'snapshot-changed' },
  { ...stateVector, contentHash: 'content-hash-changed' },
  { ...stateVector, sessionId: 'session-changed' },
  { ...stateVector, sourceTextHashes: { ...stateVector.sourceTextHashes, [stateVector.sourceEvidenceIds[0]]: 'text-changed' } },
  { ...stateVector, modelProfileId: 'profile-changed' },
  { ...stateVector, tokenizerFingerprint: 'tokenizer-changed' },
  { ...stateVector, compressionPolicyVersion: 'stage4-v2' },
  { ...stateVector, targetReductionRatio: 0.40 },
]) assert.equal(cache.get(changed), undefined, 'changed state vector must miss the derived cache');

const gate = new ModelCallBudgetGate({ maxModelCalls: 3, maxWallTimeMs: 10_000 });
const coordinator = new ModelCallCoordinator(gate, 10_000, 'react-turn', undefined, { maxEvidenceCompressionCalls: 2 });
assert.equal(coordinator.prepareEvidenceCompression({ prompt: '压缩批次一', requestedMaxOutputTokens: 256 }).ready, true);
assert.equal(coordinator.prepareEvidenceCompression({ prompt: '压缩批次二', requestedMaxOutputTokens: 256 }).ready, true);
assert.deepEqual(coordinator.prepareEvidenceCompression({ prompt: '压缩批次三' }), { ready: false, reason: 'model-budget' });
assert.equal(coordinator.evidenceCompressionCallsUsed, 2);
assert.equal(gate.modelCalls, 2);
assert.equal(gate.finalSynthesisReserved, true, 'compression calls must preserve one final synthesis slot');
assert.equal(coordinator.prepare({ callKind: 'synthesize', prompt: '最终合成' }).ready, true);
assert.equal(gate.modelCalls, 3);

console.log(JSON.stringify({ ok: true, batchCount: batches.length, batchIds: batches.map((batch) => batch.batchId), cacheKey, compressionCalls: coordinator.evidenceCompressionCallsUsed, modelCalls: gate.modelCalls }, null, 2));

function createArtifact(batch) {
  const compressedTokenCount = Math.ceil(batch.sourceTokenCount * 0.65);
  return {
    artifactId: `artifact-${batch.batchId}`,
    batchId: batch.batchId,
    snapshotId: batch.snapshotId,
    contentHash: batch.contentHash,
    sourceEvidenceIds: [...batch.sourceEvidenceIds],
    sourceTokenCount: batch.sourceTokenCount,
    compressedTokenCount,
    reductionRatio: 1 - compressedTokenCount / batch.sourceTokenCount,
    compressedSegments: [{ segmentId: `segment-${batch.batchId}`, sourceEvidenceIds: [...batch.sourceEvidenceIds], text: '乙'.repeat(compressedTokenCount), preservedTopics: ['定义', '冲突'] }],
    preservedConflicts: [],
    modelProfileId: 'profile-stage4',
    compressionPolicyVersion: 'stage4-v1',
    createdAt: '2026-08-23T00:00:00.000Z',
  };
}
