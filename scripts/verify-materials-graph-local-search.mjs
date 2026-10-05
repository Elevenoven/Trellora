import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');

// Electron --runAsNode 在受管 Windows 主机上断言失败后可能进入 Chromium 平台清理流程而挂起；
// 未捕获异常时直接退出，保证失败也能快速返回非零码。
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-local-search');
const outFile = path.join(outDir, 'graph-local-search.cjs');
// better-sqlite3 是原生模块：设为 external，bundle 内的 require 从 .package-staging
// 逐级向上解析到根 node_modules；脚本必须用 electron --run-as-node 运行（ABI 与 Electron 重编译产物一致）。
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        computeLibraryGraphKey, normalizeLibraryLeidenConfig, DEFAULT_LIBRARY_LEIDEN_CONFIG,
        WORKER_GRAPH_SCHEMA_VERSION, libraryGraphDirectory, libraryGraphRoot,
        createLibraryGraphStagingDirectory, commitLibraryGraph, readLibraryGraphReport,
      } from './electron/pipeline/libraryGraphStore';
      export {
        replaceGraphProjection, isGraphProjectionCurrent, readGraphProjectionStatus,
        removeGraphProjection, openGraphDatabase, searchGraphChunkEdgeNeighbors,
      } from './electron/pipeline/graphProjection';
      export { runGraphLocalSearch } from './electron/pipeline/graphLocalSearch';
      export { graphLocalSearchTool } from './electron/knowledge/knowledgeTools/graphLocalSearchTool';
      export { buildGraphVectorIndex, computeGraphVectorKey } from './electron/pipeline/graphVectorIndex';
      export { expandHybridChildrenViaGraph } from './electron/knowledge/graphChunkExpansion';
      export {
        graphEnhancementConfigHash, normalizeGraphEnhancementConfig, DEFAULT_GRAPH_ENHANCEMENT_CONFIG,
      } from './electron/pipeline/graphEnhancementConfig';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-local-search.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec'],
});

const {
  computeLibraryGraphKey, normalizeLibraryLeidenConfig, DEFAULT_LIBRARY_LEIDEN_CONFIG,
  libraryGraphDirectory, createLibraryGraphStagingDirectory, commitLibraryGraph, readLibraryGraphReport,
  replaceGraphProjection, isGraphProjectionCurrent, readGraphProjectionStatus, removeGraphProjection, openGraphDatabase,
  searchGraphChunkEdgeNeighbors, runGraphLocalSearch, graphLocalSearchTool,
  buildGraphVectorIndex, computeGraphVectorKey, expandHybridChildrenViaGraph,
  graphEnhancementConfigHash, normalizeGraphEnhancementConfig, DEFAULT_GRAPH_ENHANCEMENT_CONFIG,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. Leiden 配置收敛与 graphKey 确定性
// ---------------------------------------------------------------------------

const normalized = normalizeLibraryLeidenConfig({ resolution: 99, maxDepth: 20, minSplitSize: 0, seed: 7 });
assert.deepEqual(normalized, { resolution: 1.0, maxDepth: 8, minSplitSize: 2, seed: 7 }, '越界 leiden 参数必须收敛到 Python 侧同边界');
assert.deepEqual(normalizeLibraryLeidenConfig(undefined), DEFAULT_LIBRARY_LEIDEN_CONFIG, '缺省配置必须回退默认');

const keyA = computeLibraryGraphKey({ entitiesStageKeys: ['stage-b', 'stage-a'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const keyB = computeLibraryGraphKey({ entitiesStageKeys: ['stage-a', 'stage-b'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
assert.equal(keyA, keyB, 'graphKey 必须与 stageKey 传入顺序无关');
assert.match(keyA, /^[0-9a-f]{64}$/, 'graphKey 必须是 64 位十六进制');
const keyC = computeLibraryGraphKey({ entitiesStageKeys: ['stage-a', 'stage-b'], leidenConfig: { ...DEFAULT_LIBRARY_LEIDEN_CONFIG, resolution: 2.0 } });
assert.notEqual(keyA, keyC, 'leidenConfig 变化必须改变 graphKey');

const baseConfig = normalizeGraphEnhancementConfig({ ...DEFAULT_GRAPH_ENHANCEMENT_CONFIG, enabled: true });
assert.deepEqual(baseConfig.leidenConfig, DEFAULT_LIBRARY_LEIDEN_CONFIG, '配置归一化必须补齐默认 leidenConfig');
const hashWithLeidenChange = graphEnhancementConfigHash({ ...baseConfig, leidenConfig: { ...DEFAULT_LIBRARY_LEIDEN_CONFIG, resolution: 2.0 } });
assert.equal(hashWithLeidenChange, graphEnhancementConfigHash(baseConfig), 'leidenConfig 变化不得改变实体抽取缓存哈希');
console.log('[1/7] leiden 配置与 graphKey 确定性验证通过');

// ---------------------------------------------------------------------------
// 2. graphStore：staging 目录、原子提交与旧图清理
// ---------------------------------------------------------------------------

const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-local-search-lib-'));

function writeGraphArtifacts(directory, graphKey) {
  const nodes = [
    { kind: 'node', canonicalKey: '孟汉', mention: '孟汉', type: 'person', description: '猛汉Notes 的作者，负责 Trellora 桌面应用。', degree: 2, docIds: ['doc-1'], chunkIds: ['c1'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'electron', mention: 'Electron', type: 'technology', description: '用于构建桌面应用的框架。', degree: 2, docIds: ['doc-1'], chunkIds: ['c2'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'graphrag', mention: 'GraphRAG', type: 'concept', description: '知识图谱增强检索方法。', degree: 1, docIds: ['doc-1'], chunkIds: ['c3'], communityId: 'c-0-0000' },
  ];
  const edges = [
    { kind: 'edge', sourceKey: 'electron', targetKey: '孟汉', weight: 5, pmi: 0.75, strengthMean: 6.5, strengthSampleCount: 2, supportChunkCount: 2, supportDocCount: 1, kinds: ['使用'], description: '孟汉使用 Electron 开发桌面应用。', chunkIds: ['c1', 'c2'] },
    { kind: 'edge', sourceKey: 'graphrag', targetKey: '孟汉', weight: 2, pmi: 0.25, strengthMean: 4, strengthSampleCount: 1, supportChunkCount: 1, supportDocCount: 1, kinds: ['研究'], description: '孟汉研究 GraphRAG 检索方案。', chunkIds: ['c3'] },
  ];
  const communities = [
    { communityId: 'c-0-0000', level: 0, parentId: '', memberKeys: ['graphrag', 'electron', '孟汉'], edgeCount: 2, tokens: 40 },
  ];
  const report = {
    schemaVersion: 3,
    stage: 'graph',
    graphKey,
    stageKey: graphKey,
    engine: 'leiden',
    leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG,
    counts: { nodes: 3, edges: 2, communities: 1, levels: 1, chunkEdges: 1 },
    communitiesByLevel: { 0: 1 },
    modularityLevel0: 0.25,
    sourceDocuments: ['doc-1'],
    weightConfig: { version: 'pmi-v2', formula: 'weight = 1 + 9 * (0.6 * norm(PMI) + 0.4 * norm(strengthMean))', pmiWeight: 0.6, strengthWeight: 0.4, strengthAggregation: 'mean', scale: [1, 10] },
    durationMs: 12,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'graph.jsonl'), [...nodes, ...edges].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'communities.jsonl'), communities.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  // chunk 级图投影（P0-2）：c1↔c2 同文档边，权重与实体边一致。
  fs.writeFileSync(path.join(directory, 'chunk_edges.jsonl'), JSON.stringify({ chunkIdA: 'c1', chunkIdB: 'c2', weight: 5 }) + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'graph-report.json'), JSON.stringify(report, null, 2), 'utf8');
}

const graphKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-1'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
try {
  const staleKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-old'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
  const staleDirectory = libraryGraphDirectory(libraryDir, staleKey);
  writeGraphArtifacts(staleDirectory, staleKey);
  assert.ok(fs.existsSync(staleDirectory), '预置旧图目录');

  const staging = createLibraryGraphStagingDirectory(libraryDir, graphKey, 'graph-job-1');
  writeGraphArtifacts(staging, graphKey);
  const committed = commitLibraryGraph(libraryDir, graphKey, staging);
  assert.equal(committed, libraryGraphDirectory(libraryDir, graphKey), '提交目录必须是 .menghan-meta/graph/<graphKey>');
  assert.ok(!fs.existsSync(staleDirectory), '提交后旧 graphKey 目录必须被清理');
  const report = readLibraryGraphReport(libraryDir, graphKey);
  assert.equal(report?.engine, 'leiden', 'graph-report 必须可读回');
  assert.equal(report?.counts.nodes, 3);
  assert.equal(report?.counts.chunkEdges, 1, 'report 必须携带 chunk 边计数');
  assert.equal(report?.weightVersion, 'pmi-v2', 'report 必须暴露权重公式版本');
  assert.equal(report?.weightConfig.strengthAggregation, 'mean', 'report 必须完整保留可调参配置');

  const mismatched = createLibraryGraphStagingDirectory(libraryDir, graphKey, 'graph-job-2');
  const wrongKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-other'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
  writeGraphArtifacts(mismatched, wrongKey);
  assert.throws(() => commitLibraryGraph(libraryDir, graphKey, mismatched), (error) => error?.code === 'GRAPH_COMMIT_FAILED', 'graphKey 不一致必须拒绝提交');
} finally {
  // 库目录在第 3 段继续使用，失败时才清理。
}
console.log('[2/7] graphStore 布局与原子提交验证通过');

// ---------------------------------------------------------------------------
// 3. SQLite 投影：导入、读回计数、current 判定与状态
// ---------------------------------------------------------------------------

// 模拟 graph-v2 已存在的关系表，验证 replaceGraphProjection 会增量补齐原始调参列。
const legacyDatabasePath = path.join(libraryDir, '.menghan-meta', 'index.db');
fs.mkdirSync(path.dirname(legacyDatabasePath), { recursive: true });
const legacyDatabase = new BetterSqlite3(legacyDatabasePath);
try {
  legacyDatabase.exec(`
    CREATE TABLE graph_relations (
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      weight INTEGER NOT NULL CHECK (weight >= 1),
      kinds TEXT NOT NULL,
      description TEXT NOT NULL,
      chunk_ids TEXT NOT NULL,
      PRIMARY KEY (source_key, target_key)
    )
  `);
} finally {
  legacyDatabase.close();
}

const projection = replaceGraphProjection({ libraryPath: libraryDir, graphKey, graphDirectory: libraryGraphDirectory(libraryDir, graphKey) });
assert.equal(projection.readBackEntities, 3, '实体投影读回计数');
assert.equal(projection.readBackRelations, 2, '关系投影读回计数');
assert.equal(projection.readBackCommunities, 1, '社区投影读回计数');
assert.equal(projection.readBackFts, 3, 'FTS5 实体索引行数必须与实体数一致');
assert.equal(projection.importedChunkEdges, 1, 'chunk 边导入计数');
assert.equal(projection.readBackChunkEdges, 1, 'chunk 边读回计数');

const tuningDatabase = openGraphDatabase(libraryDir, false);
try {
  const tuningRow = tuningDatabase.prepare(`
    SELECT pmi, strength_mean AS strengthMean, strength_sample_count AS strengthSampleCount,
           support_chunk_count AS supportChunkCount, support_doc_count AS supportDocCount
    FROM graph_relations WHERE source_key = 'electron' AND target_key = '孟汉'
  `).get();
  assert.deepEqual(tuningRow, { pmi: 0.75, strengthMean: 6.5, strengthSampleCount: 2, supportChunkCount: 2, supportDocCount: 1 }, 'SQLite 必须保存关系权重的原始可调参分量');
  const weightConfigMeta = tuningDatabase.prepare(`SELECT value FROM graph_meta WHERE key = 'weightConfig'`).get();
  assert.equal(JSON.parse(weightConfigMeta.value).version, 'pmi-v2', 'SQLite meta 必须保存完整权重配置');
} finally {
  tuningDatabase.close();
}

assert.equal(isGraphProjectionCurrent(libraryDir, { graphKey, expectedEntities: 3, expectedCommunities: 1 }), true, 'graphKey 与计数一致时投影必须判定为 current');
assert.equal(isGraphProjectionCurrent(libraryDir, { graphKey: 'f'.repeat(64), expectedEntities: 3, expectedCommunities: 1 }), false, 'graphKey 不一致必须判定为 stale');
assert.equal(isGraphProjectionCurrent(libraryDir, { graphKey, expectedEntities: 4, expectedCommunities: 1 }), false, '预期计数不一致必须判定为 stale');

const status = readGraphProjectionStatus(libraryDir);
assert.equal(status?.graphKey, graphKey, '投影状态必须暴露当前 graphKey');
assert.equal(status?.entityCount, 3);

// 重复导入必须幂等（先清空再整体替换）。
const secondImport = replaceGraphProjection({ libraryPath: libraryDir, graphKey, graphDirectory: libraryGraphDirectory(libraryDir, graphKey) });
assert.equal(secondImport.readBackEntities, 3, '重复导入后计数不得翻倍');
console.log('[3/7] SQLite 投影与 current 判定验证通过');

// ---------------------------------------------------------------------------
// 4. graph_local_search：实体锚点、≤2 跳遍历、证据回原始 Chunk
// ---------------------------------------------------------------------------

// 预置 material_chunks / material_chunk_parents 投影行（证据必须回原始 Chunk）。
const database = openGraphDatabase(libraryDir, true);
try {
  database.exec(`
    CREATE TABLE IF NOT EXISTS material_chunks (
      id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
      parent_chunk_id TEXT, ordinal INTEGER NOT NULL, text TEXT NOT NULL,
      source_text TEXT NOT NULL DEFAULT '', section_path_json TEXT NOT NULL,
      section_context TEXT NOT NULL DEFAULT '', source_refs_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, keyword_text TEXT NOT NULL,
      UNIQUE (document_id, chunk_id)
    );
    CREATE TABLE IF NOT EXISTS material_chunk_parents (
      id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, parent_chunk_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, source_text TEXT NOT NULL,
      section_path_json TEXT NOT NULL, section_context TEXT NOT NULL,
      source_refs_json TEXT NOT NULL, content_hash TEXT NOT NULL,
      UNIQUE (document_id, parent_chunk_id)
    );
  `);
  const insertChunk = database.prepare('INSERT INTO material_chunks (document_id, chunk_id, parent_chunk_id, ordinal, text, source_text, section_path_json, section_context, source_refs_json, content_hash, keyword_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertChunk.run('doc-1', 'c1', 'p1', 0, '孟汉用 Electron 开发应用。', '孟汉用 Electron 开发应用。', '[]', '第一章', '[]', 'sha256:h1', '');
  insertChunk.run('doc-1', 'c2', 'p1', 1, 'Electron 是桌面框架。', 'Electron 是桌面框架。', '[]', '第一章', '[]', 'sha256:h2', '');
  insertChunk.run('doc-1', 'c3', 'p2', 0, 'GraphRAG 用于增强检索。', 'GraphRAG 用于增强检索。', '[]', '第二章', '[]', 'sha256:h3', '');
  const insertParent = database.prepare('INSERT INTO material_chunk_parents (document_id, parent_chunk_id, ordinal, text, source_text, section_path_json, section_context, source_refs_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertParent.run('doc-1', 'p1', 0, '第一章父块：孟汉用 Electron 开发应用；Electron 是桌面框架。', '第一章父块原文。', '[]', '第一章', '[]', 'sha256:p1');
  insertParent.run('doc-1', 'p2', 1, '第二章父块：GraphRAG 用于增强检索。', '第二章父块原文。', '[]', '第二章', '[]', 'sha256:p2');
} finally {
  database.close();
}

const noProjection = runGraphLocalSearch({ libraryPath: fs.mkdtempSync(path.join(os.tmpdir(), 'graph-empty-lib-')), query: '孟汉' });
assert.equal(noProjection, null, '无投影时图谱检索必须返回 null');

const missed = runGraphLocalSearch({ libraryPath: libraryDir, query: '不存在的实体名称' });
assert.ok(missed && missed.seeds.length === 0, '未命中锚点时返回空种子');

const outcome = runGraphLocalSearch({ libraryPath: libraryDir, query: '孟汉和 Electron 有什么关系', queryTerms: ['孟汉', 'Electron'] });
assert.ok(outcome, '命中时必须返回结果');
assert.ok(outcome.seeds.includes('孟汉'), '「孟汉」必须是锚点种子');
assert.ok(outcome.entities.some((entity) => entity.canonicalKey === '孟汉' && entity.hop === 0), '种子实体 hop 必须为 0');
assert.ok(outcome.relations.some((relation) => relation.sourceKey === 'electron' && relation.targetKey === '孟汉'), '遍历必须命中 electron↔孟汉 边');
const weights = outcome.relations.map((relation) => relation.weight);
assert.deepEqual(weights, [...weights].sort((first, second) => second - first), '关系必须按 weight 降序');
assert.ok(outcome.evidence.length > 0, '必须装配原始 Chunk 证据');
assert.ok(outcome.evidence.some((evidence) => evidence.parentChunkId === 'p1' && evidence.text.includes('第一章父块')), '证据必须回父块原文');
assert.ok(outcome.communities.length > 0 && outcome.communities[0].topMembers.length > 0, '社区导向必须携带核心成员');

const oneHop = runGraphLocalSearch({ libraryPath: libraryDir, query: 'Electron', queryTerms: ['Electron'], maxHops: 1 });
assert.ok(oneHop, '一跳检索必须返回结果');
assert.ok(oneHop.entities.some((entity) => entity.canonicalKey === '孟汉' && entity.hop === 1), '一跳必须命中直接相邻的孟汉');
assert.ok(!oneHop.entities.some((entity) => entity.canonicalKey === 'graphrag'), '一跳不得越过孟汉命中 GraphRAG');

const twoHops = runGraphLocalSearch({ libraryPath: libraryDir, query: 'Electron', queryTerms: ['Electron'], maxHops: 2 });
assert.ok(twoHops, '二跳检索必须返回结果');
assert.ok(twoHops.entities.some((entity) => entity.canonicalKey === 'graphrag' && entity.hop === 2), '二跳必须能经孟汉命中 GraphRAG');

assert.ok(graphLocalSearchTool.parameters.required.includes('max_hops'), '工具 Schema 必须要求 Agent 显式填写 max_hops');
assert.deepEqual(graphLocalSearchTool.parameters.properties.max_hops.enum, [1, 2], '工具 Schema 的 max_hops 只能声明 1 或 2');
assert.ok(graphLocalSearchTool.parameters.required.includes('entities'), '工具 Schema 必须要求 Agent 显式填写实体数组');
assert.equal(graphLocalSearchTool.parameters.properties.entities.items.type, 'string', '工具 Schema 的 entities 必须是字符串数组');
const missingHop = await graphLocalSearchTool.execute({ query: 'Electron' }, {});
assert.equal(missingHop.ok, false, '工具运行时必须拒绝缺失 max_hops');
assert.match(missingHop.observation, /只能是整数 1 或 2/, '缺失 max_hops 必须返回可纠正错误');
const invalidHop = await graphLocalSearchTool.execute({ query: 'Electron', max_hops: 3 }, {});
assert.equal(invalidHop.ok, false, '工具运行时必须拒绝 1/2 之外的跳数');
assert.match(invalidHop.observation, /只能是整数 1 或 2/, '非法 max_hops 必须返回可纠正错误');
const invalidEntities = await graphLocalSearchTool.execute({ query: 'Electron', entities: [], max_hops: 1 }, {});
assert.equal(invalidEntities.ok, false, '工具运行时必须拒绝空实体数组');
assert.match(invalidEntities.observation, /entities 必须是包含 1 到 5 个/, '非法 entities 必须返回可纠正错误');

function createGraphToolContext() {
  let reference = 0;
  return {
    signal: new AbortController().signal,
    prepareQueryContext: async (_query, options) => {
      assert.equal(options?.tokenize, false, '图谱工具必须跳过程序侧分词器');
      return { targetPath: libraryDir };
    },
    documentNameById: () => '测试文档',
    session: {
      registerEvidence: () => ({ reference: `[${++reference}]`, alreadySeen: false }),
    },
  };
}

const oneHopToolResult = await graphLocalSearchTool.execute({ query: 'Electron 与孟汉有什么直接关系', entities: ['Electron'], max_hops: 1 }, createGraphToolContext());
assert.equal(oneHopToolResult.ok, true, '合法的一跳工具调用必须成功');
assert.match(oneHopToolResult.observation, /max_hops="1"/, '工具观察必须记录 Agent 选择的一跳');
assert.match(oneHopToolResult.observation, /query_entities="Electron"/, '工具观察必须记录 Agent 提供的实体锚点');
assert.doesNotMatch(oneHopToolResult.observation, /name="GraphRAG"/, '一跳工具调用不得返回二跳实体 GraphRAG');
const twoHopToolResult = await graphLocalSearchTool.execute({ query: 'Electron 如何间接关联 GraphRAG', entities: ['Electron'], max_hops: 2 }, createGraphToolContext());
assert.equal(twoHopToolResult.ok, true, '合法的二跳工具调用必须成功');
assert.match(twoHopToolResult.observation, /max_hops="2"/, '工具观察必须记录 Agent 选择的二跳');
assert.match(twoHopToolResult.observation, /name="GraphRAG"[^>]*hop="2"/, '二跳工具调用必须返回 hop=2 的 GraphRAG 实体');

const truncated = runGraphLocalSearch({ libraryPath: libraryDir, query: '孟汉', nodeBudget: 1, edgeBudget: 1, evidenceLimit: 1 });
assert.ok(truncated, '预算参数必须生效且不抛错');
assert.ok(truncated.entities.length <= 1 && truncated.relations.length <= 1, '遍历预算必须约束节点与边数量');
console.log('[4/7] graph_local_search 查询链路验证通过');

// ---------------------------------------------------------------------------
// 5. chunk 级图投影：一跳邻居查询与图扩展只补新证据（优化方案 P0-2）
// ---------------------------------------------------------------------------

const neighborsOfC1 = searchGraphChunkEdgeNeighbors(libraryDir, ['c1'], 2);
assert.deepEqual(neighborsOfC1.map((row) => [row.neighborChunkId, row.weight]), [['c2', 5]], 'chunk 边一跳邻居必须双向可查');
const neighborsOfC2 = searchGraphChunkEdgeNeighbors(libraryDir, ['c2'], 2);
assert.deepEqual(neighborsOfC2.map((row) => row.neighborChunkId), ['c1'], '无向边从 b 端也能查到 a 端');
assert.deepEqual(searchGraphChunkEdgeNeighbors(libraryDir, ['c3'], 2), [], '无边节点不得返回邻居');

function makeHybridChild(chunkId, parentChunkId, rrfScore) {
  return {
    documentId: 'doc-1',
    chunkId,
    parentChunkId,
    ordinal: 0,
    text: `子块 ${chunkId}`,
    sectionPath: [],
    sectionContext: '第一章',
    contentHash: `sha256:${chunkId}`,
    score: rrfScore,
    bm25Score: 0,
    keywordScore: 0,
    vectorScore: 0,
    rrfScore,
    ranks: {},
    matchTypes: ['语义'],
    citation: {
      documentId: 'doc-1', chunkId, parentChunkId, contentHash: `sha256:${chunkId}`,
      text: `子块 ${chunkId}`, sourceText: `子块 ${chunkId} 原文`, sectionContext: '第一章', sourceRefs: [],
    },
  };
}

const expansion = expandHybridChildrenViaGraph({ libraryPath: libraryDir, children: [makeHybridChild('c1', 'p1', 0.02)] });
assert.equal(expansion.addedChildren, 1, '图扩展必须沿 chunk 边补充未见过的块');
assert.equal(expansion.children[0].chunkId, 'c2');
assert.deepEqual(expansion.children[0].matchTypes, ['图扩展'], '补充块必须标记图扩展通道');
assert.equal(expansion.children[0].rrfScore, Number((0.02 * (5 / 10) * 0.5).toFixed(6)), '合成 rrf 分 = 种子分 × 归一边权 × 距离衰减');
assert.equal(expansion.children[0].citation.parent?.chunkId, 'p1', '补充块引用必须带回父块');
assert.deepEqual(
  expansion.contributions.map((entry) => [entry.seedChunkId, entry.chunkId, entry.edgeWeight]),
  [['c1', 'c2', 5]],
  '图扩展遥测必须按补充块做种子归因（优化方案 P2-7）',
);

const seenExpansion = expandHybridChildrenViaGraph({
  libraryPath: libraryDir,
  children: [makeHybridChild('c1', 'p1', 0.02), makeHybridChild('c2', 'p1', 0.01)],
});
assert.equal(seenExpansion.addedChildren, 0, '主召回已见过的块不得重复补充（filterSeenChunk 语义）');
assert.deepEqual(seenExpansion.contributions, [], '未补充任何块时种子归因遥测必须为空');

const emptyLibraryExpansion = expandHybridChildrenViaGraph({ libraryPath: fs.mkdtempSync(path.join(os.tmpdir(), 'graph-empty-expand-')), children: [makeHybridChild('c1', 'p1', 0.02)] });
assert.equal(emptyLibraryExpansion.addedChildren, 0, '无投影时图扩展必须静默降级为空');
assert.deepEqual(emptyLibraryExpansion.contributions, [], '静默降级时种子归因遥测必须为空');
console.log('[5/7] chunk 级图投影与图扩展验证通过');

// ---------------------------------------------------------------------------
// 6. 语义种子（优化方案 P1-4）：实体向量近邻与 FTS 合并、低分过滤、维度降级
// ---------------------------------------------------------------------------

// 确定性正交 stub：实体向量文本 → 轴向量，自身距离 0、彼此距离 1（相似度 0）。
const seedDimension = 3;
const vectorAxes = new Map();
function axisVector(text) {
  if (!vectorAxes.has(text)) {
    const axis = vectorAxes.size % seedDimension;
    vectorAxes.set(text, Array.from({ length: seedDimension }, (_, index) => (index === axis ? 1 : 0)));
  }
  return vectorAxes.get(text);
}
await buildGraphVectorIndex({
  libraryPath: libraryDir,
  graphKey,
  vectorKey: computeGraphVectorKey({ graphKey, modelFingerprint: 'seed-stub-3' }),
  modelFingerprint: 'seed-stub-3',
  vectorDimension: seedDimension,
  callEmbed: async (texts) => texts.map(axisVector),
});
const menghanEntityVector = axisVector('「孟汉」（person）：猛汉Notes 的作者，负责 Trellora 桌面应用。');

// 纯语义命中：字面与任何实体零重叠，只有向量通道能把「孟汉」扶为锚点。
const vectorOnly = runGraphLocalSearch({ libraryPath: libraryDir, query: '谁在写记录类软件', queryTerms: ['写作', '记录', '软件'], queryEmbedding: menghanEntityVector });
assert.ok(vectorOnly, '语义种子命中时必须返回结果');
assert.deepEqual(vectorOnly.seeds, ['孟汉'], '字面零命中时向量种子必须独立扶植锚点');
assert.deepEqual(vectorOnly.vectorSeedKeys, ['孟汉'], '遥测必须暴露向量通道引入的种子');
assert.ok(vectorOnly.entities.some((entity) => entity.canonicalKey === '孟汉' && entity.hop === 0), '向量种子实体 hop 必须为 0');
assert.ok(vectorOnly.evidence.length > 0, '向量种子链路必须同样装配原始 Chunk 证据');

// 相似度低于下限（默认 0.35）时向量通道不得引入种子：用与全部实体向量反向的向量（cosine 距离 2、相似度 0）。
const orthogonalVector = [-1, 0, 0];
const belowThreshold = runGraphLocalSearch({ libraryPath: libraryDir, query: '谁在写记录类软件', queryTerms: ['写作', '记录', '软件'], queryEmbedding: orthogonalVector });
assert.ok(belowThreshold, '无向量种子时仍返回结果对象');
assert.equal(belowThreshold.seeds.length, 0, '低相似度向量种子必须被下限过滤');
assert.deepEqual(belowThreshold.vectorSeedKeys, [], '过滤后遥测键必须为空');

// 混合通道：词法命中的实体同时被向量命中时只出现一次，且仍计入向量遥测。
const hybrid = runGraphLocalSearch({ libraryPath: libraryDir, query: '孟汉', queryTerms: ['孟汉'], queryEmbedding: menghanEntityVector });
assert.ok(hybrid, '混合通道必须返回结果');
assert.deepEqual(hybrid.seeds.filter((key) => key === '孟汉'), ['孟汉'], '两通道重叠加的种子不得重复');
assert.deepEqual(hybrid.vectorSeedKeys, ['孟汉'], '字面+向量双命中仍计入向量遥测');

// 维度不匹配必须静默降级：字面命中不受影响，不抛错。
const dimensionMismatch = runGraphLocalSearch({ libraryPath: libraryDir, query: '孟汉', queryTerms: ['孟汉'], queryEmbedding: [0.1, 0.2] });
assert.ok(dimensionMismatch, '维度不匹配不得抛错');
assert.ok(dimensionMismatch.seeds.includes('孟汉'), '维度不匹配时字面通道必须不受影响');
assert.deepEqual(dimensionMismatch.vectorSeedKeys, [], '维度不匹配时向量遥测必须为空');
console.log('[6/7] 语义向量种子验证通过');

// ---------------------------------------------------------------------------
// 7. 投影清理后检索降级
// ---------------------------------------------------------------------------

removeGraphProjection(libraryDir);
assert.equal(readGraphProjectionStatus(libraryDir), null, '清理后投影状态必须为空');
assert.equal(runGraphLocalSearch({ libraryPath: libraryDir, query: '孟汉' }), null, '清理后图谱检索必须返回 null');
fs.rmSync(libraryDir, { recursive: true, force: true });
console.log('[7/7] 投影清理与降级验证通过');

console.log('materials-graph-local-search 验证通过：graphKey 确定性、原子提交、SQLite 投影、graph_local_search 查询链路、语义种子、清理降级。');

// Electron --runAsNode 在受管 Windows 主机上可能进入 Chromium 平台清理流程；
// 验证通过后主动退出，保证通过的验证器也是成功退出的进程。
process.exit(0);
