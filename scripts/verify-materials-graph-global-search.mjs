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
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-global-search');
const outFile = path.join(outDir, 'graph-global-search.cjs');
// better-sqlite3 是原生模块：设为 external，bundle 内的 require 从 .package-staging
// 逐级向上解析到根 node_modules；脚本必须用 electron --run-as-node 运行（ABI 与 Electron 重编译产物一致）。
// 临时库目录放 .package-staging 下：沙箱禁止写系统 TEMP。
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        computeLibraryGraphKey, DEFAULT_LIBRARY_LEIDEN_CONFIG, libraryGraphDirectory,
        createLibraryGraphStagingDirectory, commitLibraryGraph,
      } from './electron/pipeline/libraryGraphStore';
      export {
        replaceGraphProjection, readGraphProjectionStatus, updateGraphCommunitySummaries,
        readGraphCommunities, readGraphTopEntities, removeGraphProjection,
      } from './electron/pipeline/graphProjection';
      export {
        computeCommunitySummaryKey, generateCommunitySummaries, isCommunitySummaryCurrent,
        readCommunitySummaryRecords, readCommunitySummaryReport, parseSummaryOutput,
        COMMUNITY_SUMMARY_SCHEMA_VERSION,
      } from './electron/pipeline/communitySummaries';
      export {
        runGraphGlobalSearch, GLOBAL_SEARCH_MAX_MAP_CHUNKS,
      } from './electron/pipeline/graphGlobalSearch';
      export {
        normalizeGraphEnhancementConfig, DEFAULT_GRAPH_ENHANCEMENT_CONFIG,
      } from './electron/pipeline/graphEnhancementConfig';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-global-search.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec'],
});

const {
  computeLibraryGraphKey, DEFAULT_LIBRARY_LEIDEN_CONFIG, libraryGraphDirectory,
  createLibraryGraphStagingDirectory, commitLibraryGraph,
  replaceGraphProjection, readGraphProjectionStatus, updateGraphCommunitySummaries,
  readGraphCommunities, readGraphTopEntities, removeGraphProjection,
  computeCommunitySummaryKey, generateCommunitySummaries, isCommunitySummaryCurrent,
  readCommunitySummaryRecords, readCommunitySummaryReport, parseSummaryOutput,
  COMMUNITY_SUMMARY_SCHEMA_VERSION,
  runGraphGlobalSearch, GLOBAL_SEARCH_MAX_MAP_CHUNKS,
  normalizeGraphEnhancementConfig, DEFAULT_GRAPH_ENHANCEMENT_CONFIG,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. summaryKey 确定性与摘要输出宽松解析
// ---------------------------------------------------------------------------

const summaryKeyA = computeCommunitySummaryKey({ graphKey: 'g1', promptVersion: 'graph-summary-v1', fingerprint: 'openai|m', budgetTokens: 8000 });
const summaryKeyB = computeCommunitySummaryKey({ graphKey: 'g1', promptVersion: 'graph-summary-v1', fingerprint: 'openai|m', budgetTokens: 8000 });
assert.equal(summaryKeyA, summaryKeyB, 'summaryKey 必须确定性');
assert.notEqual(summaryKeyA, computeCommunitySummaryKey({ graphKey: 'g1', promptVersion: 'graph-summary-v2', fingerprint: 'openai|m', budgetTokens: 8000 }), '摘要 prompt 版本变化必须失效摘要');
assert.notEqual(summaryKeyA, computeCommunitySummaryKey({ graphKey: 'g1', promptVersion: 'graph-summary-v1', fingerprint: 'ollama|other', budgetTokens: 8000 }), '模型指纹变化必须失效摘要');
assert.notEqual(summaryKeyA, computeCommunitySummaryKey({ graphKey: 'g1', promptVersion: 'graph-summary-v1', fingerprint: 'openai|m', budgetTokens: 12000 }), '预算变化必须失效摘要');

assert.ok(parseSummaryOutput('{"summary":"摘要正文","key_points":["要点"],"entities":["实体"]}'), '严格 JSON 必须可解析');
assert.ok(parseSummaryOutput('好的，结果如下：\n```json\n{"summary":"摘要正文","key_points":[],"entities":[]}\n```\n以上。'), '噪声 + 代码围栏必须宽松解析');
assert.ok(parseSummaryOutput('前缀 {"summary":"摘要正文"} 后缀'), '嵌入首个花括号块必须宽松解析');
assert.equal(parseSummaryOutput('完全不是 JSON'), null, '无法解析时必须返回 null');
assert.equal(parseSummaryOutput('{"summary":""}'), null, '空 summary 必须视为解析失败');
console.log('[1/6] summaryKey 与宽松解析验证通过');

// ---------------------------------------------------------------------------
// 2. generateCommunitySummaries：自底向上、高层引用子社区摘要、失败记痕
// ---------------------------------------------------------------------------

const libraryDir = fs.mkdtempSync(path.join(outDir, 'lib-global-'));

function writeGraphArtifacts(directory, graphKey) {
  const nodes = [
    { kind: 'node', canonicalKey: '孟汉', mention: '孟汉', type: 'person', description: '猛汉Notes 的作者。', degree: 2, docIds: ['doc-1'], chunkIds: ['c1'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'electron', mention: 'Electron', type: 'technology', description: '桌面应用框架。', degree: 3, docIds: ['doc-1'], chunkIds: ['c2'], communityId: 'c-0-0000' },
    // big 的 degree 设为最大：让 big↔electron 大边按 (源degree+目degree) 降序排第一，
    // 叶级预算才会无条件装入首条大边（后续超预算边被截断），使叶上下文超 32k 触发 §3.1.5。
    { kind: 'node', canonicalKey: 'big', mention: '大描述实体', type: 'concept', description: '详'.repeat(70_000), degree: 10, docIds: ['doc-1'], chunkIds: ['c5'], communityId: 'c-0-0000' },
    { kind: 'node', canonicalKey: 'graphrag', mention: 'GraphRAG', type: 'concept', description: '图谱增强检索。', degree: 2, docIds: ['doc-1'], chunkIds: ['c3'], communityId: 'c-0-0001' },
    { kind: 'node', canonicalKey: 'leiden', mention: 'Leiden', type: 'technology', description: '社区检测算法。', degree: 2, docIds: ['doc-1'], chunkIds: ['c4'], communityId: 'c-0-0001' },
    { kind: 'node', canonicalKey: 'notes', mention: '笔记体系', type: 'concept', description: '笔记组织与检索体系。', degree: 0, docIds: ['doc-1'], chunkIds: ['c6'], communityId: 'c-0-0001' },
  ];
  const edges = [
    { kind: 'edge', sourceKey: 'electron', targetKey: '孟汉', weight: 5, kinds: ['使用'], description: '孟汉使用 Electron。', chunkIds: ['c1'] },
    { kind: 'edge', sourceKey: 'big', targetKey: 'electron', weight: 1, kinds: ['关联'], description: '大描述实体与 Electron 关联。', chunkIds: ['c5'] },
    { kind: 'edge', sourceKey: 'graphrag', targetKey: 'leiden', weight: 3, kinds: ['依赖'], description: 'GraphRAG 依赖 Leiden。', chunkIds: ['c3'] },
  ];
  // 三层完整嵌套：每个非叶社区都有子社区（避免无子社区社区被记为无上下文失败）。
  const communities = [
    { communityId: 'c-0-0000', level: 0, parentId: '', memberKeys: ['big', 'electron', '孟汉'], edgeCount: 2, tokens: 30 },
    { communityId: 'c-0-0001', level: 0, parentId: '', memberKeys: ['graphrag', 'leiden', 'notes'], edgeCount: 1, tokens: 30 },
    { communityId: 'c-1-0000', level: 1, parentId: 'c-0-0000', memberKeys: ['big', 'electron', '孟汉'], edgeCount: 2, tokens: 20 },
    { communityId: 'c-1-0001', level: 1, parentId: 'c-0-0001', memberKeys: ['graphrag', 'leiden'], edgeCount: 1, tokens: 20 },
    { communityId: 'c-1-0002', level: 1, parentId: 'c-0-0001', memberKeys: ['notes'], edgeCount: 0, tokens: 10 },
    { communityId: 'c-2-0000', level: 2, parentId: 'c-1-0000', memberKeys: ['big', 'electron', '孟汉'], edgeCount: 2, tokens: 35000 },
    { communityId: 'c-2-0001', level: 2, parentId: 'c-1-0001', memberKeys: ['graphrag', 'leiden'], edgeCount: 1, tokens: 20 },
    { communityId: 'c-2-0002', level: 2, parentId: 'c-1-0002', memberKeys: ['notes'], edgeCount: 0, tokens: 10 },
  ];
  const report = {
    schemaVersion: 1, stage: 'graph', graphKey, stageKey: graphKey, engine: 'leiden',
    leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG,
    counts: { nodes: 6, edges: 3, communities: 8, levels: 3 },
    communitiesByLevel: { 0: 2, 1: 3, 2: 3 }, modularityLevel0: 0.5,
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

const config = normalizeGraphEnhancementConfig({ ...DEFAULT_GRAPH_ENHANCEMENT_CONFIG, enabled: true });
const fingerprint = 'openai|gpt-test';
const expectedSummaryKey = computeCommunitySummaryKey({ graphKey, promptVersion: config.summaryPromptVersion, fingerprint, budgetTokens: config.summaryBudgetTokens });

const callOrder = [];
const promptByCommunity = new Map();
let callCount = 0;
const summaryResult = await generateCommunitySummaries({
  graphDirectory,
  graphKey,
  config,
  fingerprint,
  callSummary: async (text) => {
    callCount += 1;
    const idMatch = text.match(/【子社区 (c-\d+-\d+)】/);
    promptByCommunity.set(text, text);
    // 按内容确定性触发失败：仅 level-0 的 c-0-0001 上下文含【子社区 c-1-0002】→ 解析失败记痕跳过；
    // 失败放 level 0，保证 level-1 三个摘要齐全供 map-reduce 验证。
    if (text.includes('【子社区 c-1-0002】')) return '不是 JSON 的输出';
    // 固定短摘要：保证 summaryTokens < 超预算明细，§3.1.5 替换条件成立。
    const summary = idMatch ? `综合摘要（引用子社区 ${idMatch[1]}）` : '叶级社区摘要';
    callOrder.push(text);
    return `\`\`\`json\n{"summary":"${summary}","key_points":["要点1"],"entities":["孟汉"]}\n\`\`\``;
  },
});

assert.equal(summaryResult.report.counts.communities, 8, '社区总数');
assert.equal(summaryResult.report.counts.summarized, 7, '失败社区必须记痕跳过，其余成功');
assert.equal(summaryResult.report.failures.length, 1, '失败必须记痕');
assert.ok(summaryResult.report.failures[0].rawOutput.includes('不是 JSON'), '失败记痕必须保留 rawOutput 截断');
assert.equal(summaryResult.report.summaryKey, expectedSummaryKey, '报告必须携带 summaryKey');
assert.ok(isCommunitySummaryCurrent(graphDirectory, expectedSummaryKey), '产物齐全且 key 一致必须命中缓存判定');
assert.ok(!isCommunitySummaryCurrent(graphDirectory, 'f'.repeat(64)), 'summaryKey 不一致必须判定过期');

const leafFirst = callOrder[0] && !callOrder[0].includes('【子社区');
assert.ok(leafFirst, '叶级（最细层）必须先行，用边明细装配上下文');
// 定位发生 §3.1.5 替换且引用了子社区摘要文本的 prompt（c-0-0000：子社区 c-1-0000 明细超预算）；
// 同层并发顺序不确定，不能取第一个含【子社区】的 prompt。
const upperPrompt = [...promptByCommunity.values()].find((text) => text.includes('子社区摘要：') && /综合摘要（引用子社区 c-\d+-\d{4}）/.test(text));
assert.ok(upperPrompt, '子社区明细超预算时必须按论文 §3.1.5 替换为子社区摘要，且携带摘要文本');
assert.ok([...promptByCommunity.values()].some((text) => text.includes('【子社区') && !text.includes('子社区摘要：')), '未超预算的高层社区必须保留子社区明细');
assert.deepEqual(readCommunitySummaryRecords(graphDirectory).length, 7, 'jsonl 产物必须可回读');
assert.equal(readCommunitySummaryReport(graphDirectory)?.schemaVersion, COMMUNITY_SUMMARY_SCHEMA_VERSION);
console.log('[2/6] 社区摘要生成（自底向上 + 宽松回退 + 缓存键）验证通过');

// ---------------------------------------------------------------------------
// 3. 投影写回：summary/tokens + summaryCoverage + 社区/实体读取
// ---------------------------------------------------------------------------

const projection = replaceGraphProjection({ libraryPath: libraryDir, graphKey, graphDirectory });
assert.equal(projection.readBackCommunities, 8, '社区投影读回计数');
assert.equal(readGraphProjectionStatus(libraryDir)?.summaryCoverage, 0, '摘要写回前覆盖数必须为 0');

const applied = updateGraphCommunitySummaries(libraryDir, summaryResult.summaries);
assert.equal(applied.updated, 7, '摘要写回条数');
assert.equal(applied.coverage, 7, '摘要覆盖数');
const statusAfter = readGraphProjectionStatus(libraryDir);
assert.equal(statusAfter?.summaryCoverage, 7, '投影状态必须暴露摘要覆盖');
assert.ok(statusAfter?.summaryGeneratedAt, '投影状态必须暴露摘要生成时间');

const communityRows = readGraphCommunities(libraryDir);
assert.ok(communityRows && communityRows.length === 8, '社区投影读取');
assert.equal(communityRows.filter((row) => row.summary.trim()).length, 7, '摘要写回必须可回读');
assert.deepEqual(communityRows[0].level >= communityRows[communityRows.length - 1].level, true, '社区按层级降序返回');
const topEntities = readGraphTopEntities(libraryDir, 3);
assert.ok(topEntities && topEntities.length === 3, '头部实体读取');
assert.ok(topEntities.every((entity, index) => index === 0 || topEntities[index - 1].degree >= entity.degree), '头部实体必须按 degree 降序');
console.log('[3/6] 摘要投影写回与社区/实体读取验证通过');

// ---------------------------------------------------------------------------
// 4. runGraphGlobalSearch：map-reduce、滤 0 分、层级回退、小图降级
// ---------------------------------------------------------------------------

const mapScores = [80, 0, 65];
let mapIndex = 0;
let reduceCalls = 0;
const callModel = async (prompt) => {
  if (prompt.includes('综合回答器')) {
    reduceCalls += 1;
    assert.match(prompt, /有用分 [1-9]\d*/, 'reduce 必须携带滤 0 分后的部分答案与有用分');
    return '最终综合答案：该资料库围绕桌面应用与图谱检索两条主线。';
  }
  const score = mapScores[mapIndex % mapScores.length];
  mapIndex += 1;
  return JSON.stringify({ answer_part: `部分答案 ${mapIndex}`, score, community_ids: ['c-1-0000'] });
};

// 用长摘要覆盖 level-1 社区（估算器 CJK 1 字≈1 token：每条 ≈2400 token，
// 6k 分块预算下两条合一块、第三条独立成块 → 恰好 2 块），
// 直接走投影写回以绕过摘要文本 1200 字上限。
{
  const longRecords = (readGraphCommunities(libraryDir) ?? [])
    .filter((row) => row.level === 1)
    .map((row) => ({ communityId: row.communityId, level: row.level, summary: '概'.repeat(2_400), keyPoints: [], entities: [], tokens: 2_400 }));
  const overridden = updateGraphCommunitySummaries(libraryDir, longRecords);
  assert.ok(overridden.updated >= 2, '覆盖 level-1 摘要用于 map 分块验证');
}

const globalResult = await runGraphGlobalSearch({ libraryPath: libraryDir, query: '这个资料库整体讲了什么？', callModel });
assert.equal(globalResult.mode, 'map-reduce', '默认配置（level=1）必须走 map-reduce');
assert.equal(globalResult.level, 1, '默认层级必须取配置 globalSearchLevel=1');
assert.ok(globalResult.mapChunks >= 2, '长摘要必须分出多块（验证 0 分滤除需要 ≥2 块）');
assert.ok(globalResult.answer.includes('最终综合答案'), '终答必须来自 reduce');
assert.equal(reduceCalls, 1, 'reduce 只调用一次');
assert.equal(globalResult.partials.length, 1, '0 分部分答案必须被滤除');
assert.ok(globalResult.partials.every((partial) => partial.score > 0), '保留的部分答案必须均 >0 分');
assert.equal(globalResult.llmCalls, globalResult.mapChunks + 1, 'LLM 调用数 = 分块数 + 1（成本护栏口径）');
assert.ok(globalResult.communities.length > 0, '必须返回参与社区列表');

const levelFallback = await runGraphGlobalSearch({ libraryPath: libraryDir, query: '整体概览', level: 3, callModel: async () => JSON.stringify({ answer_part: 'x', score: 50, community_ids: [] }) });
assert.notEqual(levelFallback.level, 3, '请求层无摘要时必须回退到有摘要的最邻近层');
assert.ok(levelFallback.mode === 'map-reduce' || levelFallback.mode === 'entity-overview', '回退后必须走有效链路');

const smallGraph = await runGraphGlobalSearch({ libraryPath: libraryDir, query: '整体概览', level: 0, callModel: async () => { throw new Error('小图降级不应发起 LLM 调用'); } });
assert.equal(smallGraph.mode, 'entity-overview', '该层社区 <3 必须降级为实体概览');
assert.ok(smallGraph.entities.length > 0, '实体概览必须携带头部实体');
assert.equal(smallGraph.llmCalls, 0, '实体概览模式不得发起 LLM 调用');

const noProjection = await runGraphGlobalSearch({ libraryPath: fs.mkdtempSync(path.join(outDir, 'lib-empty-')), query: '概览', callModel });
assert.equal(noProjection.mode, 'unavailable', '无投影必须返回 unavailable');
console.log('[4/6] graph_global_search map-reduce 与降级链路验证通过');

// ---------------------------------------------------------------------------
// 5. 成本护栏：分块数超过上限时拒绝 map-reduce
// ---------------------------------------------------------------------------

const bigLibraryDir = fs.mkdtempSync(path.join(outDir, 'lib-cost-'));
const bigGraphKey = computeLibraryGraphKey({ entitiesStageKeys: ['entities-stage-big'], leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG });
const bigStaging = createLibraryGraphStagingDirectory(bigLibraryDir, bigGraphKey, 'graph-job-big');
{
  const chunkCount = GLOBAL_SEARCH_MAX_MAP_CHUNKS + 2;
  const nodes = [];
  const communities = [];
  for (let index = 0; index < chunkCount; index += 1) {
    nodes.push({ kind: 'node', canonicalKey: `n${index}`, mention: `实体${index}`, type: 'concept', description: `实体 ${index} 的描述。`, degree: 0, docIds: ['doc-1'], chunkIds: [], communityId: `c-1-${String(index).padStart(4, '0')}` });
    communities.push({ communityId: `c-1-${String(index).padStart(4, '0')}`, level: 1, parentId: '', memberKeys: [`n${index}`], edgeCount: 0, tokens: 10 });
  }
  const report = {
    schemaVersion: 1, stage: 'graph', graphKey: bigGraphKey, stageKey: bigGraphKey, engine: 'leiden',
    leidenConfig: DEFAULT_LIBRARY_LEIDEN_CONFIG,
    counts: { nodes: chunkCount, edges: 0, communities: chunkCount, levels: 2 },
    communitiesByLevel: { 1: chunkCount }, modularityLevel0: 0,
    sourceDocuments: ['doc-1'], durationMs: 1, generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(bigStaging, { recursive: true });
  fs.writeFileSync(path.join(bigStaging, 'graph.jsonl'), nodes.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(bigStaging, 'communities.jsonl'), communities.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(bigStaging, 'chunk_edges.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(bigStaging, 'graph-report.json'), JSON.stringify(report, null, 2), 'utf8');
}
const bigGraphDirectory = commitLibraryGraph(bigLibraryDir, bigGraphKey, bigStaging);
replaceGraphProjection({ libraryPath: bigLibraryDir, graphKey: bigGraphKey, graphDirectory: bigGraphDirectory });
const longSummary = '长'.repeat(13_000); // CJK 1 字≈1 token：每社区 ≈13000 token，必然一社区一分块
{
  const records = [];
  const rows = readGraphCommunities(bigLibraryDir) ?? [];
  for (const row of rows) records.push({ communityId: row.communityId, level: row.level, summary: longSummary, keyPoints: [], entities: [], tokens: 6500 });
  updateGraphCommunitySummaries(bigLibraryDir, records);
}
const guarded = await runGraphGlobalSearch({
  libraryPath: bigLibraryDir,
  query: '整体概览',
  level: 1,
  callModel: async () => { throw new Error('成本护栏触发后不得发起 LLM 调用'); },
});
assert.equal(guarded.mode, 'cost-guard', '超过成本护栏必须拦截');
assert.ok(guarded.mapChunks > GLOBAL_SEARCH_MAX_MAP_CHUNKS, '护栏分块数必须超过上限');
assert.equal(guarded.llmCalls, 0, '护栏模式不得发起 LLM 调用');
assert.ok(guarded.note.includes('graph_local_search'), '护栏提示必须引导改用 local 检索');
console.log('[5/6] 成本护栏验证通过');

// ---------------------------------------------------------------------------
// 6. 投影清理后全局检索降级
// ---------------------------------------------------------------------------

removeGraphProjection(libraryDir);
assert.equal(readGraphProjectionStatus(libraryDir), null, '清理后投影状态必须为空');
const communitiesAfterRemoval = readGraphCommunities(libraryDir);
assert.ok(communitiesAfterRemoval === null || communitiesAfterRemoval.length === 0, '清理后社区读取必须为空');
const afterRemoval = await runGraphGlobalSearch({ libraryPath: libraryDir, query: '概览', callModel });
assert.equal(afterRemoval.mode, 'unavailable', '清理后全局检索必须降级为 unavailable');
removeGraphProjection(bigLibraryDir);
fs.rmSync(libraryDir, { recursive: true, force: true });
fs.rmSync(bigLibraryDir, { recursive: true, force: true });
console.log('[6/6] 投影清理与全局检索降级验证通过');

console.log('materials-graph-global-search 验证通过：摘要生成与缓存、投影写回、map-reduce 与降级、成本护栏、清理降级。');

// Electron --runAsNode 在受管 Windows 主机上可能进入 Chromium 平台清理流程；
// 验证通过后主动退出，保证通过的验证器也是成功退出的进程。
process.exit(0);
