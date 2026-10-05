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
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-alias');
const outFile = path.join(outDir, 'graph-alias.cjs');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        ARBITRATION_COSINE_THRESHOLD, ARBITRATION_MAX_CANDIDATES, ARBITRATION_MIN_CONFIDENCE,
        filterAliasCandidates, computeAliasGroupFingerprint, computeAliasGroupCacheKey,
        buildArbitrationPayload, parseArbitrationOutput, resolveAliasDecision,
        arbitrateAliasGroups, readAliasArbitrationCache, appendAliasArbitrationCache,
        writeAliasArtifacts, loadEntitiesFromArtifactDirs, applyAliasMapToEntitiesDirs,
        ALIAS_DECISIONS_FILE_NAME, ALIAS_MAP_FILE_NAME,
      } from './electron/pipeline/aliasArbitration';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-alias.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec'],
});

const {
  ARBITRATION_COSINE_THRESHOLD, ARBITRATION_MAX_CANDIDATES, ARBITRATION_MIN_CONFIDENCE,
  filterAliasCandidates, computeAliasGroupFingerprint, computeAliasGroupCacheKey,
  buildArbitrationPayload, parseArbitrationOutput, resolveAliasDecision,
  arbitrateAliasGroups, readAliasArbitrationCache, appendAliasArbitrationCache,
  writeAliasArtifacts, loadEntitiesFromArtifactDirs, applyAliasMapToEntitiesDirs,
  ALIAS_DECISIONS_FILE_NAME, ALIAS_MAP_FILE_NAME,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. 指纹与缓存键确定性
// ---------------------------------------------------------------------------

const group = {
  sourceKey: '微软',
  source: { mention: '微软', type: 'organization', description: '美国科技公司。' },
  candidates: [
    { candidateKey: 'Microsoft', mention: 'Microsoft', type: 'organization', description: 'Microsoft Corporation。', similarity: 0.95 },
  ],
};
const fingerprintA = computeAliasGroupFingerprint(group);
assert.equal(fingerprintA, computeAliasGroupFingerprint({ ...group, candidates: [...group.candidates].reverse() }), '候选顺序不得影响组指纹');
assert.notEqual(fingerprintA, computeAliasGroupFingerprint({ ...group, sourceKey: '微软中国' }), '组内容变化必须改变指纹');
const cacheKeyA = computeAliasGroupCacheKey({ groupFingerprint: fingerprintA, modelFingerprint: 'model-a' });
assert.equal(cacheKeyA, computeAliasGroupCacheKey({ groupFingerprint: fingerprintA, modelFingerprint: 'model-a' }), '缓存键必须确定性');
assert.notEqual(cacheKeyA, computeAliasGroupCacheKey({ groupFingerprint: fingerprintA, modelFingerprint: 'model-b' }), '模型指纹变化必须失效裁决缓存');
console.log('[1/6] 指纹与缓存键验证通过');

// ---------------------------------------------------------------------------
// 2. 候选过滤：阈值、类型相容、排除自身、上限与排序
// ---------------------------------------------------------------------------

const neighbors = [
  { rowId: 1, canonicalKey: '微软', mention: '微软', type: 'organization', distance: 0.0 },
  { rowId: 2, canonicalKey: 'Microsoft', mention: 'Microsoft', type: 'organization', distance: 1 - 0.95 },
  { rowId: 3, canonicalKey: '微软亚洲研究院', mention: '微软亚研', type: 'organization', distance: 1 - 0.9 },
  { rowId: 4, canonicalKey: '微软概念', mention: '微软概念', type: 'concept', distance: 1 - 0.99 },
  { rowId: 5, canonicalKey: '低相似', mention: '低相似', type: 'organization', distance: 1 - (ARBITRATION_COSINE_THRESHOLD - 0.01) },
  ...Array.from({ length: 6 }, (_, index) => ({ rowId: 10 + index, canonicalKey: `候选${index}`, mention: `候选${index}`, type: 'organization', distance: 1 - (0.87 + index * 0.001) })),
];
const filtered = filterAliasCandidates(neighbors, { sourceKey: '微软', type: 'organization' });
assert.ok(!filtered.some((candidate) => candidate.candidateKey === '微软'), '必须排除自身');
assert.ok(!filtered.some((candidate) => candidate.candidateKey === '微软概念'), '类型不同不得进入裁决');
assert.ok(!filtered.some((candidate) => candidate.candidateKey === '低相似'), '低于阈值的候选必须过滤');
assert.equal(filtered.length, ARBITRATION_MAX_CANDIDATES, '候选数不得超过上限');
assert.equal(filtered[0].candidateKey, 'Microsoft', '必须按相似度降序');
assert.ok(filtered.every((candidate) => candidate.similarity >= ARBITRATION_COSINE_THRESHOLD), '全部候选必须满足阈值');
console.log('[2/6] 候选过滤验证通过');

// ---------------------------------------------------------------------------
// 3. 强契约解析：严格 JSON，失败即 null（无宽松回退）
// ---------------------------------------------------------------------------

const validOutput = JSON.stringify({ decisions: [{ candidateKey: 'Microsoft', merge: true, canonicalKey: 'Microsoft', confidence: 92, reason: '同一公司' }] });
assert.deepEqual(parseArbitrationOutput(validOutput)?.[0].candidateKey, 'Microsoft', '严格 JSON 必须可解析');
assert.equal(parseArbitrationOutput('```json\n' + validOutput + '\n```'), null, '代码围栏包装必须判为失败（强契约无宽松回退）');
assert.equal(parseArbitrationOutput('完全不是 JSON'), null, '非 JSON 必须判为失败');
assert.equal(parseArbitrationOutput(JSON.stringify({ decisions: [{ candidateKey: 'Microsoft', merge: 'yes', canonicalKey: 'Microsoft', confidence: 90, reason: '' }] })), null, 'merge 非布尔必须判为失败');
assert.equal(parseArbitrationOutput(JSON.stringify({ decisions: [{ candidateKey: 'Microsoft', merge: true, canonicalKey: 'Microsoft', confidence: 150, reason: '' }] })), null, '置信度越界必须判为失败');
assert.equal(parseArbitrationOutput(JSON.stringify({ decisions: 'not-array' })), null, 'decisions 非数组必须判为失败');

const groupForResolve = { ...group };
const merged = resolveAliasDecision(groupForResolve, parseArbitrationOutput(validOutput));
assert.deepEqual({ status: merged.status, canonicalKey: merged.canonicalKey }, { status: 'merged', canonicalKey: 'Microsoft' }, '高置信合并必须生效');
const lowConfidence = resolveAliasDecision(groupForResolve, [{ candidateKey: 'Microsoft', merge: true, canonicalKey: 'Microsoft', confidence: ARBITRATION_MIN_CONFIDENCE - 1, reason: '不确定' }]);
assert.equal(lowConfidence.status, 'pending', `置信度低于 ${ARBITRATION_MIN_CONFIDENCE} 必须进 pending`);
const badCanonical = resolveAliasDecision(groupForResolve, [{ candidateKey: 'Microsoft', merge: true, canonicalKey: '组外键', confidence: 99, reason: '' }]);
assert.equal(badCanonical.status, 'pending', 'canonicalKey 落在组外必须忽略该决定');
console.log('[3/6] 强契约解析与裁决决议验证通过');

// ---------------------------------------------------------------------------
// 4. 仲裁流程：失败记痕、产物与别名映射
// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(outDir, 'alias-'));
const graphKey = 'g'.repeat(64);
const failingGroup = {
  sourceKey: '苹果',
  source: { mention: '苹果', type: 'organization', description: '科技公司。' },
  candidates: [{ candidateKey: 'Apple', mention: 'Apple', type: 'organization', description: 'Apple Inc.', similarity: 0.93 }],
};
let callCount = 0;
const prompts = [];
const firstRun = await arbitrateAliasGroups({
  groups: [group, failingGroup],
  graphKey,
  modelFingerprint: 'model-a',
  callArbitrate: async (text) => {
    callCount += 1;
    prompts.push(text);
    if (text.includes('"苹果"')) return '不是 JSON 的输出';
    return validOutput;
  },
});
assert.equal(callCount, 2, '每组候选一次调用');
assert.equal(firstRun.result.records.length, 2, '裁决记录必须齐全');
const failedRecord = firstRun.result.records.find((record) => record.sourceKey === '苹果');
assert.equal(failedRecord.status, 'failed', '解析失败必须记痕跳过');
assert.equal(failedRecord.reason.includes('严格 JSON'), true, '失败原因必须记痕');
assert.deepEqual(firstRun.result.aliasMap, { 微软: 'Microsoft' }, '只有成功合并进入别名映射');
assert.ok(JSON.parse(prompts[0]).source.key === '微软' || JSON.parse(prompts[1]).source.key === '微软', '请求文本必须是结构化 JSON 载荷');

writeAliasArtifacts(workDir, firstRun.result.records, firstRun.result.aliasMap);
const decisionLines = fs.readFileSync(path.join(workDir, ALIAS_DECISIONS_FILE_NAME), 'utf8').trim().split('\n');
assert.equal(decisionLines.length, 2, '审计产物必须逐组一行');
assert.ok(JSON.parse(decisionLines[0]).candidates, '审计产物必须携带候选');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workDir, ALIAS_MAP_FILE_NAME), 'utf8')), { 微软: 'Microsoft' }, 'alias-map 产物必须可回读');
console.log('[4/6] 仲裁流程与审计产物验证通过');

// ---------------------------------------------------------------------------
// 5. 缓存不重复裁决
// ---------------------------------------------------------------------------

const cachePath = path.join(workDir, 'cache.jsonl');
appendAliasArbitrationCache(cachePath, firstRun.newRecords);
const secondRun = await arbitrateAliasGroups({
  groups: [group, failingGroup],
  graphKey: 'h'.repeat(64),
  modelFingerprint: 'model-a',
  callArbitrate: async () => { callCount += 1; return validOutput; },
  existingCache: readAliasArbitrationCache(cachePath),
});
assert.equal(callCount, 2, '缓存命中的组不得重复调用模型');
assert.deepEqual(secondRun.result.aliasMap, { 微软: 'Microsoft' }, '缓存复用必须产生同样的合并');
assert.ok(secondRun.result.records.every((record) => record.reused === true), '复用记录必须标记 reused');
assert.equal(secondRun.newRecords.length, 0, '复用不得产生新裁决记录');
const thirdRun = await arbitrateAliasGroups({
  groups: [group],
  graphKey,
  modelFingerprint: 'model-b',
  callArbitrate: async () => validOutput,
  existingCache: readAliasArbitrationCache(cachePath),
});
assert.equal(thirdRun.newRecords.length, 1, '模型指纹变化必须重新裁决');
console.log('[5/6] 缓存不重复裁决验证通过');

// ---------------------------------------------------------------------------
// 6. Electron 侧预映射：产物改写与自环丢弃
// ---------------------------------------------------------------------------

const sourceDir = path.join(workDir, 'doc-1');
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(path.join(sourceDir, 'entities.jsonl'), [
  JSON.stringify({ canonicalKey: '微软', mention: '微软', type: 'organization', description: '美国科技公司。', chunkIds: ['c1'] }),
  JSON.stringify({ canonicalKey: 'Microsoft', mention: 'Microsoft', type: 'organization', description: 'Microsoft Corporation。', chunkIds: ['c2'] }),
  JSON.stringify({ canonicalKey: 'electron', mention: 'Electron', type: 'technology', description: '桌面应用框架。', chunkIds: ['c3'] }),
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(sourceDir, 'relations.jsonl'), [
  JSON.stringify({ sourceKey: '微软', targetKey: 'electron', weight: 2, kind: '使用', description: '微软使用 Electron。', chunkIds: ['c1'] }),
  JSON.stringify({ sourceKey: 'Microsoft', targetKey: 'electron', weight: 1, kind: '使用', description: 'Microsoft 使用 Electron。', chunkIds: ['c2'] }),
  JSON.stringify({ sourceKey: '微软', targetKey: 'Microsoft', weight: 1, kind: '相关', description: '别名关系。', chunkIds: ['c1'] }),
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(sourceDir, 'extraction-report.json'), JSON.stringify({ documentId: 'doc-1' }), 'utf8');

const loaded = loadEntitiesFromArtifactDirs([{ documentId: 'doc-1', directory: sourceDir }]);
assert.equal(loaded.size, 3, '实体加载必须按 canonicalKey 去重');

const stagingRoot = path.join(workDir, 'staging');
const mappedDirs = applyAliasMapToEntitiesDirs({
  entries: [{ documentId: 'doc-1', directory: sourceDir }],
  aliasMap: { 微软: 'Microsoft' },
  stagingRoot,
});
assert.equal(mappedDirs.length, 1, '每个文档一个映射目录');
const mappedEntities = fs.readFileSync(path.join(mappedDirs[0], 'entities.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.deepEqual(mappedEntities.map((row) => row.canonicalKey), ['Microsoft', 'Microsoft', 'electron'], '实体 canonicalKey 必须被映射（重复键留给图阶段归并）');
const mappedRelations = fs.readFileSync(path.join(mappedDirs[0], 'relations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(mappedRelations.length, 2, '映射产生的自环边必须丢弃');
assert.ok(mappedRelations.every((row) => row.sourceKey === 'Microsoft' && row.targetKey === 'electron'), '关系两端必须同步映射');
assert.ok(fs.existsSync(path.join(mappedDirs[0], 'extraction-report.json')), 'extraction-report 必须随产物复制');
console.log('[6/6] Electron 侧预映射验证通过');

console.log('verify-materials-graph-alias: 全部 6 段验证通过');
process.exit(0);
