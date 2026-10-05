import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-query-expansion');
const outFile = path.join(outDir, 'queryExpansion.cjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'queryExpansion.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { expandQueriesLocally, mergeRecalledChildren, QUERY_EXPANSION_MAX_VARIANTS } = await import(pathToFileURL(outFile).href);

// 1. 疑问词前缀剥离：「什么是谐波抑制」→「谐波抑制」。
const stripped = expandQueriesLocally('什么是谐波抑制');
assert.ok(stripped.variants.includes('谐波抑制'), '疑问词前缀必须剥离成陈述式变体');
assert.ok(stripped.strategies.includes('question-word-strip'));

// 2. 引号短语原样保留。
const quoted = expandQueriesLocally('请解释"谐波抑制装置"的作用');
assert.ok(quoted.variants.includes('谐波抑制装置'), '引号短语必须原样保留为变体');
assert.ok(quoted.strategies.includes('quoted-phrase'));

// 3. 分隔符拆分：复合问题拆成独立子句。
const split = expandQueriesLocally('谐波抑制的原理，以及应用场景');
assert.ok(split.variants.includes('谐波抑制的原理'), '复合问题必须按分隔符拆分');
assert.ok(split.variants.includes('以及应用场景'));
assert.ok(split.strategies.includes('delimiter-split'));

// 4. 分词重组：去停用词后用空格连接。
const joined = expandQueriesLocally('谐波抑制的方案是什么', ['谐波', '抑制', '的', '方案', '是']);
assert.ok(joined.variants.includes('谐波 抑制 方案'), '停用词必须从重组变体中剔除');
assert.ok(joined.strategies.includes('term-join'));

// 5. 与原文重复的变体剔除、变体数不超上限。
const duplicated = expandQueriesLocally('谐波抑制', ['谐波', '抑制']);
assert.ok(!duplicated.variants.includes('谐波抑制'), '与原文重复的变体必须剔除');
assert.ok(duplicated.variants.length <= QUERY_EXPANSION_MAX_VARIANTS);
assert.equal(QUERY_EXPANSION_MAX_VARIANTS, 5);

// 6. 空查询：不产生任何变体。
assert.deepEqual(expandQueriesLocally('   '), { variants: [], strategies: [] });

// 7. mergeRecalledChildren：首轮优先拼接通道名次后重走规范 RRF。
const child = (documentId, chunkId, parentChunkId, ranks, extra = {}) => ({
  documentId,
  chunkId,
  parentChunkId,
  ordinal: 0,
  text: chunkId,
  sourceText: chunkId,
  sectionContext: '',
  matchTypes: [],
  citation: { parent: null },
  ranks,
  rrfScore: 0,
  score: 0,
  ...extra,
});
const firstRound = [
  child('doc', 'A', 'P1', { vector: 1, lexical: 1 }, { tag: 'first' }),
  child('doc', 'B', 'P1', { vector: 2, lexical: 2 }),
];
const expansionRounds = [
  // A 在扩写轮再次命中（名次不得覆盖首轮），C 为扩写独有。
  [
    child('doc', 'A', 'P1', { vector: 1, lexical: 1 }, { tag: 'expansion' }),
    child('doc', 'C', 'P2', { lexical: 3 }),
  ],
];
const merged = mergeRecalledChildren(firstRound, expansionRounds);
const expect = (value) => Number(value.toFixed(6));
const byChunk = new Map(merged.map((row) => [row.chunkId, row]));
// 向量通道名次：A=1、B=2；词法通道名次：A=1、B=2、C=3（首轮优先）。
assert.equal(byChunk.get('A').rrfScore, expect(1 / 61 + 1 / 61));
assert.equal(byChunk.get('B').rrfScore, expect(1 / 62 + 1 / 62));
assert.equal(byChunk.get('C').rrfScore, expect(1 / 63));
assert.deepEqual(merged.map((row) => row.chunkId), ['A', 'B', 'C']);
assert.equal(byChunk.get('A').tag, 'first', '重复子块的字段主体必须保留首轮行');
assert.deepEqual(byChunk.get('A').ranks, { vector: 1, lexical: 1 });
assert.deepEqual(byChunk.get('C').ranks, { lexical: 3 });

console.log('Query expansion verification passed: local variant strategies and multi-round RRF merge contracts');
