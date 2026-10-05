import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-rrf-fusion');
const outFile = path.join(outDir, 'rrfFusion.cjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'hybridRetrievalFusion.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { reciprocalRankFusion, aggregateParentScores, fuseRerankScores } = await import(pathToFileURL(outFile).href);

// 1. RRF 数学：rank-based，缺失通道不惩罚。
const fused = reciprocalRankFusion({ vectorKeys: ['A', 'B', 'C'], lexicalKeys: ['B', 'D', 'A'] });
const expect = (value) => Number(value.toFixed(6));
assert.equal(fused.get('B').rrfScore, expect(1 / 62 + 1 / 61));
assert.equal(fused.get('A').rrfScore, expect(1 / 61 + 1 / 63));
assert.equal(fused.get('D').rrfScore, expect(1 / 62));
assert.equal(fused.get('C').rrfScore, expect(1 / 63));
assert.deepEqual(fused.get('A').vectorRank, 1);
assert.deepEqual(fused.get('A').lexicalRank, 3);
assert.equal(fused.get('C').lexicalRank, undefined);
const order = [...fused.entries()].sort((x, y) => y[1].rrfScore - x[1].rrfScore).map(([key]) => key);
assert.deepEqual(order, ['B', 'A', 'D', 'C']);

// 2. 父块聚合：base 主导 + support 加成；无父块子块跳过；norm 归一。
const child = (chunkId, parentChunkId, rrfScore) => ({ documentId: 'doc', chunkId, parentChunkId, rrfScore });
const aggregates = aggregateParentScores([
  child('c1', 'P1', 0.03),
  child('c2', 'P1', 0.02),
  child('c3', 'P2', 0.025),
  child('c4', null, 0.09),
]);
assert.equal(aggregates.length, 2);
assert.equal(aggregates[0].parentChunkId, 'P1');
assert.equal(aggregates[0].score, expect(0.03 + 0.2 * 0.02));
assert.equal(aggregates[0].hitChildren, 2);
assert.equal(aggregates[0].bestChildChunkId, 'c1');
assert.equal(aggregates[0].normScore, 1);
assert.equal(aggregates[1].parentChunkId, 'P2');
assert.equal(aggregates[1].normScore, expect(0.025 / 0.034));

// 3. rerank 融合：β=0.7 融合 + τ=0.25 gating。
const fusion = fuseRerankScores([1, 0.8], [0.9, 0.1]);
assert.equal(fusion.finals[0], expect(0.7 * 0.9 + 0.3 * 1));
assert.equal(fusion.finals[1], expect(0.7 * 0.1 + 0.3 * 0.8));
assert.deepEqual(fusion.order, [0]);
assert.equal(fusion.gatedOut, 1);
assert.equal(fusion.allGatedOut, false);

// 4. gating 全剔除：降级重滤（τ'=0.25×0.7=0.175）后仍全剔除，调用方应回退 RRF 聚合序 Top-1。
const allGated = fuseRerankScores([1, 0.9], [0.1, 0.15]);
assert.deepEqual(allGated.order, []);
assert.equal(allGated.allGatedOut, true);
assert.equal(allGated.gatedOut, 2);
assert.equal(allGated.degradedThreshold, 0.175);

// 5. 降级重滤救回候选：首轮全剔除，τ'=0.175 时 0.2 的候选应被救回。
const degradedRescue = fuseRerankScores([1], [0.2]);
assert.deepEqual(degradedRescue.order, [0]);
assert.equal(degradedRescue.allGatedOut, false);
assert.equal(degradedRescue.degradedThreshold, 0.175);

// 6. 历史引用放宽：上轮已引用的父块阈值放宽 0.1（0.25-0.1=0.15），非历史父块仍被剔除。
const historyRelief = fuseRerankScores([1, 1], [0.2, 0.2], { historyIndices: [0] });
assert.deepEqual(historyRelief.order, [0]);
assert.equal(historyRelief.gatedOut, 1);
assert.equal(historyRelief.degradedThreshold, undefined);

// 7. 数量不一致必须抛错，避免静默错位。
assert.throws(() => fuseRerankScores([1], [0.5, 0.6]), /RERANK_COUNT_MISMATCH/);

console.log('RRF fusion verification passed: rrf math, parent aggregation, rerank gating, degraded retry, history relief and fallback contracts');
