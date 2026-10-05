import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-evidence-diversity');
const diversityOut = path.join(outDir, 'evidenceDiversity.cjs');
const directLoadOut = path.join(outDir, 'directLoad.cjs');
const stubPath = path.join(outDir, 'material-chunk-search-stub.ts');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. MMR 多样性选择：无原生依赖，直接 bundle。
await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'evidenceDiversity.ts')],
  outfile: diversityOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { selectDiverseTopK, MMR_LAMBDA } = await import(pathToFileURL(diversityOut).href);
assert.equal(MMR_LAMBDA, 0.7);

const repeatedText = '谐波抑制装置通过滤波器对电网中的高次谐波进行吸收与补偿，从而改善电能质量。';
const candidates = [
  { key: 'docA|P1', finalScore: 1.0, text: repeatedText },
  { key: 'docA|P2', finalScore: 0.95, text: repeatedText },
  { key: 'docB|P1', finalScore: 0.6, text: '项目交付流程分为需求澄清、方案设计、实施验收三个阶段，每阶段都有明确的评审门。' },
];

// 1a. 重复文本抑制：两个高分同文档重复父块只保留一个，多样性候选被救回。
const diverse = selectDiverseTopK(candidates, 2);
assert.deepEqual(diverse.selected.map((item) => item.key), ['docA|P1', 'docB|P1'], '第二个重复父块必须被 MMR 抑制，让位给多样性候选');
assert.equal(diverse.dropped, 1);

// 1b. 空输入与零预算。
assert.deepEqual(selectDiverseTopK([], 3), { selected: [], dropped: 0 });
assert.deepEqual(selectDiverseTopK(candidates, 0).selected, []);

// 1c. 首位始终直选（相关性优先），dropped 计数正确。
const all = selectDiverseTopK(candidates, 3);
assert.equal(all.selected[0].key, 'docA|P1');
assert.equal(all.dropped, 0);

// 2. 小文档直载决策：materialChunkSearch 依赖原生模块，用桩替换后测纯决策。
writeFileSync(stubPath, [
  'let handler = () => [];',
  'export const __setDirectLoadDocuments = (fn) => { handler = fn; };',
  'export const readMaterialDirectLoadDocuments = (input) => handler(input);',
].join('\n'), 'utf8');
const materialStubPlugin = {
  name: 'material-chunk-search-stub',
  setup(context) {
    context.onResolve({ filter: /materialChunkSearch/u }, () => ({ path: stubPath }));
  },
};
await build({
  stdin: {
    contents: [
      "export { selectDirectLoadDocuments, readDirectLoadCandidates, DIRECT_LOAD_MAX_CHILD_CHUNKS, DIRECT_LOAD_MAX_PARENTS } from './electron/knowledge/directLoadSmallDocuments.ts';",
      "export { __setDirectLoadDocuments } from './.package-staging/verify-evidence-diversity/material-chunk-search-stub.ts';",
    ].join('\n'),
    resolveDir: rootDir,
    sourcefile: 'verify-direct-load-entry.ts',
  },
  outfile: directLoadOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [materialStubPlugin],
});
const { selectDirectLoadDocuments, readDirectLoadCandidates, DIRECT_LOAD_MAX_CHILD_CHUNKS, DIRECT_LOAD_MAX_PARENTS, __setDirectLoadDocuments } = await import(pathToFileURL(directLoadOut).href);
assert.equal(DIRECT_LOAD_MAX_CHILD_CHUNKS, 40);
assert.equal(DIRECT_LOAD_MAX_PARENTS, 4);

// 2a. 纯决策：按子块数升序、父块预算内整文档直载，超预算文档跳过。
const documents = [
  { documentId: 'big', childChunks: 10, parents: Array.from({ length: 5 }, (_, index) => ({ parentChunkId: `big-${index}`, ordinal: index, text: `t${index}`, sourceText: `t${index}` })) },
  { documentId: 'small-a', childChunks: 3, parents: [{ parentChunkId: 'a-0', ordinal: 0, text: 'ta', sourceText: 'ta' }, { parentChunkId: 'a-1', ordinal: 1, text: 'tb', sourceText: 'tb' }] },
  { documentId: 'small-b', childChunks: 6, parents: [{ parentChunkId: 'b-0', ordinal: 0, text: 'tc', sourceText: 'tc' }] },
];
const selected = selectDirectLoadDocuments(documents, 4);
assert.deepEqual(selected.map((doc) => doc.documentId), ['small-a', 'small-b'], '子块数升序选取；父块超预算的文档必须整文档跳过而不是半截直载');

// 2b. readDirectLoadCandidates：候选展平 + documentIds 投影；查询失败必须返回空而非抛错。
__setDirectLoadDocuments(() => documents);
const outcome = readDirectLoadCandidates('/fake/library');
assert.deepEqual(outcome.documentIds, ['small-a', 'small-b']);
assert.deepEqual(outcome.candidates.map((candidate) => candidate.parentChunkId), ['a-0', 'a-1', 'b-0']);
assert.ok(outcome.candidates.every((candidate) => candidate.directLoad === true));
__setDirectLoadDocuments(() => { throw new Error('sqlite unavailable'); });
assert.deepEqual(readDirectLoadCandidates('/fake/library'), { candidates: [], documentIds: [] }, '直载通道失败必须静默降级为空结果');

console.log('Evidence diversity verification passed: MMR redundancy suppression and small-document direct-load contracts');
