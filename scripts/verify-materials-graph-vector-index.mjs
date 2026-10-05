import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Electron --runAsNode 在受管 Windows 主机上断言失败后可能进入 Chromium 平台清理流程而挂起；
// 未捕获异常时直接退出，保证失败也能快速返回非零码。
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-vector-index');
const outFile = path.join(outDir, 'graph-vector-index.cjs');
// better-sqlite3 / sqlite-vec 是原生模块：设为 external，bundle 内的 require 从 .package-staging
// 逐级向上解析到根 node_modules；脚本必须用 electron --run-as-node 运行（ABI 与 Electron 重编译产物一致）。
// 临时库目录放 .package-staging 下：沙箱禁止写系统 TEMP。
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        computeLibraryGraphKey, DEFAULT_LIBRARY_LEIDEN_CONFIG,
        createLibraryGraphStagingDirectory, commitLibraryGraph,
      } from './electron/pipeline/libraryGraphStore';
      export {
        replaceGraphProjection, readGraphProjectionStatus, updateGraphCommunitySummaries,
        removeGraphProjection,
      } from './electron/pipeline/graphProjection';
      export {
        computeGraphVectorKey, buildGraphVectorIndex, isGraphVectorIndexCurrent,
        buildGraphEntityVectorText, queryGraphEntityVectorNeighbors, queryGraphCommunityVectorNeighbors,
        GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS,
      } from './electron/pipeline/graphVectorIndex';
      export { estimateTokenCount } from './electron/knowledge/tokenEstimator';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-vector-index.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec'],
});

const {
  computeLibraryGraphKey, DEFAULT_LIBRARY_LEIDEN_CONFIG,
  createLibraryGraphStagingDirectory, commitLibraryGraph,
  replaceGraphProjection, readGraphProjectionStatus, updateGraphCommunitySummaries,
  removeGraphProjection,
  computeGraphVectorKey, buildGraphVectorIndex, isGraphVectorIndexCurrent,
  buildGraphEntityVectorText, queryGraphEntityVectorNeighbors, queryGraphCommunityVectorNeighbors,
  GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS,
  estimateTokenCount,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. vectorKey 确定性与失效敏感性
// ---------------------------------------------------------------------------

const vectorKeyA = computeGraphVectorKey({ graphKey: 'g1', modelFingerprint: 'model-a' });
const vectorKeyB = computeGraphVectorKey({ graphKey: 'g1', modelFingerprint: 'model-a' });
assert.equal(vectorKeyA, vectorKeyB, 'vectorKey 必须确定性');
assert.notEqual(vectorKeyA, computeGraphVectorKey({ graphKey: 'g2', modelFingerprint: 'model-a' }), 'graphKey 变化必须失效向量');
assert.notEqual(vectorKeyA, computeGraphVectorKey({ graphKey: 'g1', modelFingerprint: 'model-b' }), '模型指纹变化必须失效向量');

assert.equal(
  buildGraphEntityVectorText({ mention: 'Electron', type: 'technology', description: '桌面应用框架。' }),
  '「Electron」（technology）：桌面应用框架。',
  '实体向量文本必须是「mention」（type）：description 格式',
);
const longText = buildGraphEntityVectorText({ mention: '长', type: 'concept', description: '详'.repeat(5_000) });
assert.ok(estimateTokenCount(longText) <= GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS, '超长描述必须截断到 800 token 预算内');
console.log('[1/7] vectorKey 与向量文本装配验证通过');

// ---------------------------------------------------------------------------
// 2. 构建图向量索引：实体全量、社区仅有摘要者、文本捕获
// ---------------------------------------------------------------------------

const libraryDir = fs.mkdtempSync(path.join(outDir, 'lib-vector-'));

function writeGraphArtifacts(directory, graphKey, electronDescription = '桌面应用框架。') {
  const nodes = [
    { kind: 'node', canonicalKey: '孟汉', mention: '孟汉', type: 'person', description: '猛汉Notes 的作者。', degree: 1, docIds: ['doc-1'], chunkIds: ['c1'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'electron', mention: 'Electron', type: 'technology', description: electronDescription, degree: 1, docIds: ['doc-1'], chunkIds: ['c2'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'longdesc', mention: '大描述实体', type: 'concept', description: '详'.repeat(5_000), degree: 0, docIds: ['doc-1'], chunkIds: ['c3'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'graphrag', mention: 'GraphRAG', type: 'concept', description: '图谱增强检索。', degree: 0, docIds: ['doc-1'], chunkIds: ['c4'], communityId: 'c-0-0001' },
  ];
  const edges = [
    { kind: 'edge', sourceKey: 'electron', targetKey: '孟汉', weight: 5, kinds: ['使用'], description: '孟汉使用 Electron。', chunkIds: ['c1'] },
  ];
  const communities = [
    { communityId: 'c-0-0000', level: 0, parentId: '', memberKeys: ['孟汉', 'electron', 'longdesc'], edgeCount: 1, tokens: 30 },
    { communityId: 'c-0-0001', level: 0, parentId: '', memberKeys: ['graphrag'], edgeCount: 0, tokens: 10 },
  ];
  const report = {
    schemaVersion: 1, stage: 'graph', graphKey, stageKey: graphKey, engine: 'leiden',
    leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG,
    counts: { nodes: 4, edges: 1, communities: 2, levels: 1 },
    communitiesByLevel: { 0: 2 }, modularityLevel0: 0.5,
    sourceDocuments: ['doc-1'], durationMs: 5, generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'graph.jsonl'), [...nodes, ...edges].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'communities.jsonl'), communities.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'chunk_edges.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(directory, 'graph-report.json'), JSON.stringify(report, null, 2), 'utf8');
}

const graphKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-1'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const staging = createLibraryGraphStagingDirectory(libraryDir, graphKey, 'graph-job-1');
writeGraphArtifacts(staging, graphKey);
const graphDirectory = commitLibraryGraph(libraryDir, graphKey, staging);
replaceGraphProjection({ libraryPath: libraryDir, graphKey, graphDirectory });

// 只给 c-0-0000 写摘要：c-0-0001 无摘要必须被向量索引跳过。
const applied = updateGraphCommunitySummaries(libraryDir, [
  { communityId: 'c-0-0000', level: 0, summary: '孟汉用 Electron 做笔记应用的社区摘要。', keyPoints: ['要点'], entities: ['孟汉'], tokens: 20 },
]);
assert.equal(applied.coverage, 1, '摘要写回覆盖数');

// 确定性 stub embedding：sha256(text) 前 8 字节归一化到 [-0.5, 0.5]。
const dimension = 8;
function stubVector(text) {
  const hash = crypto.createHash('sha256').update(text).digest();
  return Array.from(hash.subarray(0, dimension), (byte) => byte / 255 - 0.5);
}
const capturedTexts = [];
const callEmbed = async (texts) => {
  capturedTexts.push(...texts);
  return texts.map(stubVector);
};

const vectorKey = computeGraphVectorKey({ graphKey, modelFingerprint: 'stub-model-8' });
const result = await buildGraphVectorIndex({
  libraryPath: libraryDir,
  graphKey,
  vectorKey,
  modelFingerprint: 'stub-model-8',
  vectorDimension: dimension,
  callEmbed,
});
assert.equal(result.entityVectors, 4, '全部实体必须入向量索引');
assert.equal(result.communityVectors, 1, '无摘要社区必须跳过');
assert.equal(result.dimension, dimension, '结果必须携带维度');
assert.ok(result.durationMs >= 0, '结果必须携带耗时');
assert.equal(result.entityVectorsReused, 0, '首次构建无缓存可复用');
assert.equal(result.communityVectorsReused, 0, '首次构建无缓存可复用');
assert.equal(capturedTexts.length, 5, '文本总数 = 实体 4 + 有摘要社区 1');
assert.ok(capturedTexts.every((text) => estimateTokenCount(text) <= GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS), '所有向量文本必须在 800 token 预算内');
assert.ok(capturedTexts.some((text) => text.startsWith('「Electron」（technology）：')), '实体文本格式必须进入批量调用');
assert.ok(capturedTexts.includes('孟汉用 Electron 做笔记应用的社区摘要。'), '社区文本必须是摘要原文');
console.log('[2/7] 图向量索引构建验证通过');

// ---------------------------------------------------------------------------
// 3. 读回：状态暴露、缓存判定、KNN 召回
// ---------------------------------------------------------------------------

const statusAfter = readGraphProjectionStatus(libraryDir);
assert.equal(statusAfter?.vectorCoverage, 5, '投影状态必须暴露向量覆盖数');
assert.ok(statusAfter?.vectorGeneratedAt, '投影状态必须暴露向量生成时间');
assert.ok(isGraphVectorIndexCurrent(libraryDir, vectorKey), 'vectorKey 一致必须命中缓存判定');
assert.ok(!isGraphVectorIndexCurrent(libraryDir, 'f'.repeat(64)), 'vectorKey 不一致必须判定过期');

const electronVector = stubVector('「Electron」（technology）：桌面应用框架。');
const entityNeighbors = queryGraphEntityVectorNeighbors(libraryDir, electronVector, 3);
assert.deepEqual(queryGraphEntityVectorNeighbors(libraryDir, electronVector, 3, 'different-generation'), [], '同维度的另一模型不能查询旧图向量');
assert.equal(entityNeighbors.length, 3, 'KNN 必须返回 limit 个邻居');
assert.equal(entityNeighbors[0].canonicalKey, 'electron', '自身向量查询首位必须是该实体');
assert.ok(entityNeighbors[0].distance < 0.001, '自身向量距离必须趋近 0');
assert.ok(entityNeighbors.every((row) => typeof row.mention === 'string' && typeof row.type === 'string'), 'KNN 必须回读实体字段');

const communityNeighbors = queryGraphCommunityVectorNeighbors(libraryDir, stubVector('孟汉用 Electron 做笔记应用的社区摘要。'), 2);
assert.ok(communityNeighbors.length >= 1, '社区 KNN 必须可查');
assert.equal(communityNeighbors[0].communityId, 'c-0-0000', '社区 KNN 首位必须是摘要所属社区');
assert.equal(communityNeighbors[0].level, 0, '社区 KNN 必须回读层级');
console.log('[3/7] 状态/缓存判定/KNN 召回验证通过');

// ---------------------------------------------------------------------------
// 4. 覆盖重建：模型指纹变化 + 维度变化整体重建
// ---------------------------------------------------------------------------

const newVectorKey = computeGraphVectorKey({ graphKey, modelFingerprint: 'stub-model-6' });
const newDimension = 6;
const stubVector6 = (text) => Array.from(crypto.createHash('sha256').update(text).digest().subarray(0, newDimension), (byte) => byte / 255 - 0.5);
const rebuilt = await buildGraphVectorIndex({
  libraryPath: libraryDir,
  graphKey,
  vectorKey: newVectorKey,
  modelFingerprint: 'stub-model-6',
  vectorDimension: newDimension,
  callEmbed: async (texts) => texts.map(stubVector6),
});
assert.equal(rebuilt.entityVectors, 4, '重建后实体覆盖不变');
assert.equal(rebuilt.communityVectors, 1, '重建后社区覆盖不变');
assert.ok(isGraphVectorIndexCurrent(libraryDir, newVectorKey), '重建后新 vectorKey 必须命中');
assert.ok(!isGraphVectorIndexCurrent(libraryDir, vectorKey), '重建后旧 vectorKey 必须过期');
assert.equal(readGraphProjectionStatus(libraryDir)?.vectorCoverage, 5, '重建后状态覆盖数不变');

// 旧维度 8 的查询向量必须被维度守卫拒绝（空结果），新维度可查。
assert.deepEqual(queryGraphEntityVectorNeighbors(libraryDir, electronVector, 3), [], '维度不符的查询必须返回空');
const rebuiltNeighbors = queryGraphEntityVectorNeighbors(libraryDir, stubVector6('「Electron」（technology）：桌面应用框架。'), 2);
assert.equal(rebuiltNeighbors[0]?.canonicalKey, 'electron', '新维度索引必须可召回');
console.log('[4/7] 覆盖重建（指纹/维度失效）验证通过');

// ---------------------------------------------------------------------------
// 5. 增量复用（优化方案 P1-5）：单实体变化后二次构建只嵌入变化项
// ---------------------------------------------------------------------------

// 模拟单文档重解析触发图重建：改 electron 描述，其余实体/社区不变。
const graphKey2 = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-2'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const staging2 = createLibraryGraphStagingDirectory(libraryDir, graphKey2, 'graph-job-2');
writeGraphArtifacts(staging2, graphKey2, '跨平台桌面应用运行时。');
const graphDirectory2 = commitLibraryGraph(libraryDir, graphKey2, staging2);
replaceGraphProjection({ libraryPath: libraryDir, graphKey: graphKey2, graphDirectory: graphDirectory2 });
updateGraphCommunitySummaries(libraryDir, [
  { communityId: 'c-0-0000', level: 0, summary: '孟汉用 Electron 做笔记应用的社区摘要。', keyPoints: ['要点'], entities: ['孟汉'], tokens: 20 },
]);

const reuseVectorKey = computeGraphVectorKey({ graphKey: graphKey2, modelFingerprint: 'stub-model-6' });
const reuseCaptured = [];
const reuseResult = await buildGraphVectorIndex({
  libraryPath: libraryDir,
  graphKey: graphKey2,
  vectorKey: reuseVectorKey,
  modelFingerprint: 'stub-model-6',
  vectorDimension: newDimension,
  callEmbed: async (texts) => {
    reuseCaptured.push(...texts);
    return texts.map(stubVector6);
  },
});
assert.equal(reuseResult.entityVectors, 4, '二次构建实体覆盖不变');
assert.equal(reuseResult.entityVectorsReused, 3, '未变化的 3 个实体必须命中缓存');
assert.equal(reuseResult.communityVectorsReused, 1, '未变化的社区摘要必须命中缓存');
assert.deepEqual(reuseCaptured, ['「Electron」（technology）：跨平台桌面应用运行时。'], '只有变化实体进入 embedding 调用');
assert.deepEqual(
  queryGraphEntityVectorNeighbors(libraryDir, stubVector6('「Electron」（technology）：跨平台桌面应用运行时。'), 1)[0]?.canonicalKey,
  'electron',
  '复用路径下变化实体仍可召回',
);
console.log('[5/7] 增量复用验证通过');

// ---------------------------------------------------------------------------
// 6. 失败契约：批内数量不一致 / 维度错误必须抛错（换维度使缓存字节数失配，强制走 embedding）
// ---------------------------------------------------------------------------

const failDimension = 4;
await assert.rejects(
  buildGraphVectorIndex({
    libraryPath: libraryDir, graphKey, vectorKey: 'e'.repeat(64), modelFingerprint: 'bad',
    vectorDimension: failDimension,
    callEmbed: async (texts) => texts.slice(1).map(() => Array.from({ length: failDimension }, () => 0.1)),
  }),
  /向量/,
  '批内返回数量不一致必须抛错',
);
await assert.rejects(
  buildGraphVectorIndex({
    libraryPath: libraryDir, graphKey, vectorKey: 'e'.repeat(64), modelFingerprint: 'bad',
    vectorDimension: failDimension,
    callEmbed: async (texts) => texts.map(() => [0.1, 0.2]),
  }),
  /维度/,
  '返回维度错误必须抛错',
);
assert.ok(isGraphVectorIndexCurrent(libraryDir, reuseVectorKey), '失败构建不得破坏既有索引');
console.log('[6/7] 失败契约验证通过');

// ---------------------------------------------------------------------------
// 7. 清理降级：removeGraphProjection 一并废弃向量索引与复用缓存
// ---------------------------------------------------------------------------

removeGraphProjection(libraryDir);
const statusAfterRemoval = readGraphProjectionStatus(libraryDir);
assert.ok(statusAfterRemoval === null || statusAfterRemoval.vectorCoverage === 0, '清理后投影状态必须归零');
assert.ok(!isGraphVectorIndexCurrent(libraryDir, newVectorKey), '清理后缓存判定必须失效');
assert.deepEqual(queryGraphEntityVectorNeighbors(libraryDir, electronVector, 3), [], '清理后实体 KNN 必须返回空');
assert.deepEqual(queryGraphCommunityVectorNeighbors(libraryDir, stubVector('任意'), 3), [], '清理后社区 KNN 必须返回空');

// 缓存表必须随投影清理删除：重建时不得命中旧向量（清理后缓存为空，全部重新嵌入）。
const graphKey3 = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-3'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const staging3 = createLibraryGraphStagingDirectory(libraryDir, graphKey3, 'graph-job-3');
writeGraphArtifacts(staging3, graphKey3);
const graphDirectory3 = commitLibraryGraph(libraryDir, graphKey3, staging3);
replaceGraphProjection({ libraryPath: libraryDir, graphKey: graphKey3, graphDirectory: graphDirectory3 });
updateGraphCommunitySummaries(libraryDir, [
  { communityId: 'c-0-0000', level: 0, summary: '孟汉用 Electron 做笔记应用的社区摘要。', keyPoints: ['要点'], entities: ['孟汉'], tokens: 20 },
]);
const afterCleanup = await buildGraphVectorIndex({
  libraryPath: libraryDir,
  graphKey: graphKey3,
  vectorKey: computeGraphVectorKey({ graphKey: graphKey3, modelFingerprint: 'stub-model-6' }),
  modelFingerprint: 'stub-model-6',
  vectorDimension: newDimension,
  callEmbed: async (texts) => texts.map(stubVector6),
});
assert.equal(afterCleanup.entityVectorsReused, 0, '投影清理后缓存必须失效，全量重新嵌入');
console.log('[7/7] 清理降级验证通过');

console.log('verify-materials-graph-vector-index: 全部 7 段验证通过');
process.exit(0);
