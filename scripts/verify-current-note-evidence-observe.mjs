import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.package-staging', 'verify-current-note-evidence-observe');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

await Promise.all([
  bundle('electron/knowledge/planAwarePromptProjector.ts', 'prompt-projector.cjs'),
  bundle('src/components/assistantPlanPresentation.ts', 'assistant-plan-presentation.cjs'),
]);

const { PlanAwarePromptProjector } = await import(pathToFileURL(path.join(stagingDir, 'prompt-projector.cjs')).href);
const { getAssistantEvidenceContextView } = await import(pathToFileURL(path.join(stagingDir, 'assistant-plan-presentation.cjs')).href);

const baseInput = {
  callKind: 'synthesize',
  stablePrefix: '仅基于当前笔记中已读取的证据回答。',
  question: '当前笔记的结论是什么？',
  outputSchema: '{"type":"object"}',
  evidence: [
    { evidenceId: 'evidence-001', text: '已读取的结论原文。', snapshotId: 'snapshot-001', contentHash: 'hash-001', lineFrom: 1, lineTo: 2 },
  ],
};
const searchHitMetadata = [
  { blockId: 'block-001', lineFrom: 1, lineTo: 8, snippet: '这是第一条搜索命中摘要。', headingPath: ['结论'] },
  { blockId: 'block-001', lineFrom: 1, lineTo: 8, snippet: '重复命中不应重复计算。', headingPath: ['结论'] },
  { blockId: 'block-002', lineFrom: 12, lineTo: 20, snippet: '这是第二条搜索命中摘要。', headingPath: ['背景'] },
];

const projector = new PlanAwarePromptProjector();
const baseline = projector.build(baseInput);
const observed = projector.build({
  ...baseInput,
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
  searchHitMetadata,
  evidenceBudgetTokens: 10,
});
const allRetrievedObserved = projector.build({
  ...baseInput,
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'observe',
  searchHitMetadata,
  evidenceBudgetTokens: 10,
});

assert.equal(hash(baseline.prompt), hash(observed.prompt), 'observe 不得改变 minimal Provider Prompt。');
assert.equal(hash(baseline.prompt), hash(allRetrievedObserved.prompt), '阶段 1 不得因 all-retrieved 改变 Provider Prompt。');
assert.deepEqual(observed.segments, baseline.segments, 'observe 不得改变 Prompt segments。');
assert.deepEqual(observed.evidenceContextStats, observed.promptStats.evidenceContextStats);

const stats = observed.evidenceContextStats;
assert.ok(stats);
assert.equal(stats.accuracy, 'estimate');
assert.equal(stats.manifestStatus, 'not-materialized');
assert.equal(stats.searchHitCount, 3);
assert.equal(stats.uniqueSearchHitCount, 2);
assert.ok(stats.estimatedRawEvidenceTokens > 0);
assert.equal(stats.mayNeedCompression, true);
assert.equal(stats.compressionBatchCount, undefined, '阶段 1 不得宣称批次数准确。');
assert.equal(stats.rawCount, undefined, '阶段 1 不得宣称 raw 计数准确。');

const publicPlanEvent = {
  phase: 'updated',
  status: 'active',
  goals: [],
  evidenceContextStats: stats,
};
const serializedEvent = JSON.stringify(publicPlanEvent);
assert.equal(serializedEvent.includes('这是第一条搜索命中摘要'), false);
assert.equal(serializedEvent.includes('block-001'), false);
assert.equal(serializedEvent.includes('C:\\'), false);
assert.equal(serializedEvent.includes('provider'), false);
assert.deepEqual(getAssistantEvidenceContextView(stats), {
  accuracyLabel: '估算',
  searchHitLabel: '搜索命中 3 次（去重后 2 条）',
  tokenEstimateLabel: `对应原文约 ${stats.estimatedRawEvidenceTokens} tokens`,
  compressionLabel: '可能需要压缩',
  manifestLabel: 'Manifest 尚未物化',
});

const off = projector.build({
  ...baseInput,
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'off',
  searchHitMetadata,
  evidenceBudgetTokens: 10,
});
assert.equal(hash(baseline.prompt), hash(off.prompt), 'off 也必须保持现有 Provider Prompt。');
assert.equal(off.evidenceContextStats, undefined, 'off 不应发布 observe 旁路统计。');

console.log(JSON.stringify({
  ok: true,
  promptHash: hash(baseline.prompt),
  observedStats: stats,
  publicEventKeys: Object.keys(publicPlanEvent).sort(),
}, null, 2));

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
