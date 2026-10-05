import assert from 'node:assert/strict';
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
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-visualization');
const outFile = path.join(outDir, 'graph-visualization.cjs');
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
        replaceGraphProjection, updateGraphCommunitySummaries,
        readGraphVisualizationPayload, searchGraphVisualizationEntities,
      } from './electron/pipeline/graphProjection';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-visualization.ts',
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
  replaceGraphProjection, updateGraphCommunitySummaries,
  readGraphVisualizationPayload, searchGraphVisualizationEntities,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. 搭建真实投影：两社区 + 跨社区边 + 三层社区
// ---------------------------------------------------------------------------

const libraryDir = fs.mkdtempSync(path.join(outDir, 'lib-vis-'));

function writeGraphArtifacts(directory, graphKey) {
  const nodes = [
    { kind: 'node', canonicalKey: '孟汉', mention: '孟汉', type: 'person', description: '猛汉Notes 的作者。', degree: 4, docIds: ['doc-1'], chunkIds: ['c1'], communityId: 'c-0' },
    { kind: 'node', canonicalKey: 'electron', mention: 'Electron', type: 'technology', description: '桌面应用框架。', degree: 3, docIds: ['doc-1'], chunkIds: ['c2'], communityId: 'c-0' },
    { kind: 'node', canonicalKey: 'graphrag', mention: 'GraphRAG', type: 'concept', description: '图谱增强检索。', degree: 2, docIds: ['doc-1'], chunkIds: ['c3'], communityId: 'c-1' },
    { kind: 'node', canonicalKey: 'leiden', mention: 'Leiden', type: 'technology', description: '社区检测算法。', degree: 1, docIds: ['doc-1'], chunkIds: ['c4'], communityId: 'c-1' },
  ];
  const edges = [
    { kind: 'edge', sourceKey: '孟汉', targetKey: 'electron', weight: 5, kinds: ['使用'], description: '孟汉使用 Electron。', chunkIds: ['c1'] },
    { kind: 'edge', sourceKey: 'graphrag', targetKey: 'leiden', weight: 3, kinds: ['依赖'], description: 'GraphRAG 依赖 Leiden。', chunkIds: ['c3'] },
    { kind: 'edge', sourceKey: '孟汉', targetKey: 'graphrag', weight: 4, kinds: ['研究'], description: '孟汉研究 GraphRAG。', chunkIds: ['c1'] },
    { kind: 'edge', sourceKey: 'electron', targetKey: 'leiden', weight: 1, kinds: ['关联'], description: '关联边。', chunkIds: ['c2'] },
  ];
  const communities = [
    { communityId: 'c-0', level: 0, parentId: '', memberKeys: ['孟汉', 'electron'], edgeCount: 1, tokens: 20 },
    { communityId: 'c-1', level: 0, parentId: '', memberKeys: ['graphrag', 'leiden'], edgeCount: 1, tokens: 20 },
    { communityId: 'c-1-0', level: 1, parentId: 'c-0', memberKeys: ['孟汉', 'electron'], edgeCount: 1, tokens: 12 },
    { communityId: 'c-1-1', level: 1, parentId: 'c-1', memberKeys: ['graphrag', 'leiden'], edgeCount: 1, tokens: 12 },
    { communityId: 'c-2-0', level: 2, parentId: 'c-1-0', memberKeys: ['孟汉', 'electron'], edgeCount: 1, tokens: 8 },
  ];
  const report = {
    schemaVersion: 1, stage: 'graph', graphKey, stageKey: graphKey, engine: 'leiden',
    leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG,
    counts: { nodes: 4, edges: 4, communities: 5, levels: 3 },
    communitiesByLevel: { 0: 2, 1: 2, 2: 1 }, modularityLevel0: 0.5,
    sourceDocuments: ['doc-1'], durationMs: 5, generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'graph.jsonl'), [...nodes, ...edges].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'communities.jsonl'), communities.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'chunk_edges.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(directory, 'graph-report.json'), JSON.stringify(report, null, 2), 'utf8');
}

const graphKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-vis'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const staging = createLibraryGraphStagingDirectory(libraryDir, graphKey, 'graph-vis-job');
writeGraphArtifacts(staging, graphKey);
commitLibraryGraph(libraryDir, graphKey, staging);
replaceGraphProjection({ libraryPath: libraryDir, graphKey, graphDirectory: path.join(libraryDir, '.menghan-meta', 'graph', graphKey) });
updateGraphCommunitySummaries(libraryDir, [
  { communityId: 'c-0', level: 0, summary: '孟汉与 Electron 的社区。', keyPoints: [], entities: [], tokens: 12 },
  { communityId: 'c-1', level: 0, summary: 'GraphRAG 与 Leiden 的社区。', keyPoints: [], entities: [], tokens: 12 },
]);
console.log('[1/5] 投影搭建完成');

// ---------------------------------------------------------------------------
// 2. 全量载荷：结构、排序与社区摘要
// ---------------------------------------------------------------------------

const full = readGraphVisualizationPayload(libraryDir);
assert.ok(full, '已有投影必须返回载荷');
assert.equal(full.status.graphKey, graphKey, '载荷必须携带状态');
assert.deepEqual(full.entities.map((entity) => entity.canonicalKey), ['孟汉', 'electron', 'graphrag', 'leiden'], '实体必须按 degree 降序、键升序');
assert.equal(full.entities[0].communityId, 'c-0', '实体必须携带社区归属');
assert.equal(full.edges.length, 4, '小图全部边都应保留');
assert.deepEqual(full.communities.map((community) => community.communityId).sort(), ['c-0', 'c-1', 'c-1-0', 'c-1-1'], '只取 level 0/1 社区');
assert.equal(full.communities.find((community) => community.communityId === 'c-0').summary, '孟汉与 Electron 的社区。', '社区必须携带摘要');
assert.deepEqual(full.communities.find((community) => community.communityId === 'c-0').memberKeys, ['孟汉', 'electron'], '社区成员必须回读');
assert.equal(full.truncated, false, '未超限不得标记截断');
console.log('[2/5] 全量载荷验证通过');

// ---------------------------------------------------------------------------
// 3. 社区聚合边：跨社区权重和与条数，同社区边不计入
// ---------------------------------------------------------------------------

assert.equal(full.communityEdges.length, 1, '只有一对社区存在跨社区边');
const aggregate = full.communityEdges[0];
assert.deepEqual({ source: aggregate.sourceCommunityId, target: aggregate.targetCommunityId, weight: aggregate.weight, count: aggregate.edgeCount },
  { source: 'c-0', target: 'c-1', weight: 5, count: 2 }, '聚合边 = 跨社区成员边的权重和与条数');
console.log('[3/5] 社区聚合边验证通过');

// ---------------------------------------------------------------------------
// 4. 节点上限：degree 截断、边只保留集合内、截断标记
// ---------------------------------------------------------------------------

const capped = readGraphVisualizationPayload(libraryDir, { nodeLimit: 3 });
assert.equal(capped.entities.length, 3, '实体数不得超过上限');
assert.deepEqual(capped.entities.map((entity) => entity.canonicalKey), ['孟汉', 'electron', 'graphrag'], '截断必须按 degree 降序取头部');
assert.ok(capped.edges.every((edge) => capped.entities.some((entity) => entity.canonicalKey === edge.sourceKey)
  && capped.entities.some((entity) => entity.canonicalKey === edge.targetKey)), '边只允许保留两端都在集合内');
assert.equal(capped.edges.length, 2, '越界端点的边必须剔除');
assert.equal(capped.truncated, true, '超限必须标记截断');
assert.equal(capped.communityEdges.length, 1, '聚合边不受实体上限影响（基于全量归属）');
console.log('[4/5] 节点上限与截断验证通过');

// ---------------------------------------------------------------------------
// 5. 实体搜索（FTS 优先 + LIKE 回退）与无投影降级
// ---------------------------------------------------------------------------

const ftsHits = searchGraphVisualizationEntities(libraryDir, '孟汉');
assert.ok(ftsHits.some((entity) => entity.canonicalKey === '孟汉'), '完整词必须经 FTS 命中');
const likeHits = searchGraphVisualizationEntities(libraryDir, 'lec');
assert.ok(likeHits.some((entity) => entity.canonicalKey === 'electron'), '子串必须经 LIKE 回退命中');
assert.equal(searchGraphVisualizationEntities(libraryDir, '').length, 0, '空查询必须返回空');

const emptyLibrary = fs.mkdtempSync(path.join(outDir, 'lib-empty-'));
assert.equal(readGraphVisualizationPayload(emptyLibrary), null, '无投影必须返回 null');
assert.deepEqual(searchGraphVisualizationEntities(emptyLibrary, '孟汉'), [], '无投影搜索必须返回空数组');
console.log('[5/5] 搜索与降级验证通过');

console.log('verify-materials-graph-visualization: 全部 5 段验证通过');
process.exit(0);
