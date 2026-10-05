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
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-summary-incremental');
const outFile = path.join(outDir, 'summary-incremental.cjs');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        computeCommunityMemberFingerprint, inheritReusableSummaries,
        generateCommunitySummaries, readCommunitySummaryRecords, readCommunitySummaryReport,
      } from './electron/pipeline/communitySummaries';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-summary-incremental.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3', 'sqlite-vec'],
});

const {
  computeCommunityMemberFingerprint, inheritReusableSummaries,
  generateCommunitySummaries, readCommunitySummaryRecords, readCommunitySummaryReport,
} = await import(pathToFileURL(outFile).href);

const config = { summaryPromptVersion: 'v1', summaryBudgetTokens: 400 };

function summaryStub(prefix) {
  let counter = 0;
  const texts = [];
  const callSummary = async (text) => {
    counter += 1;
    texts.push(text);
    return JSON.stringify({ summary: `${prefix}摘要-${counter}`, key_points: ['要点'], entities: ['实体'] });
  };
  return { texts, count: () => counter, callSummary };
}

function writeGraphArtifacts(graphDirectory, nodes, edges, communities) {
  fs.mkdirSync(graphDirectory, { recursive: true });
  const lines = [
    ...nodes.map((node) => JSON.stringify({ kind: 'node', ...node })),
    ...edges.map((edge) => JSON.stringify({ kind: 'edge', ...edge })),
  ];
  fs.writeFileSync(path.join(graphDirectory, 'graph.jsonl'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(graphDirectory, 'communities.jsonl'), communities.map((community) => JSON.stringify(community)).join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 1. 成员指纹：确定性、顺序/重复无关、level 与成员敏感
// ---------------------------------------------------------------------------

const fingerprintA = computeCommunityMemberFingerprint(['b', 'a', 'c'], 1);
assert.equal(fingerprintA, computeCommunityMemberFingerprint(['c', 'a', 'b'], 1), '成员顺序不得影响指纹');
assert.equal(fingerprintA, computeCommunityMemberFingerprint(['a', 'b', 'c', 'a'], 1), '重复成员必须先归一');
assert.notEqual(fingerprintA, computeCommunityMemberFingerprint(['a', 'b', 'c'], 0), 'level 变化必须改变指纹');
assert.notEqual(fingerprintA, computeCommunityMemberFingerprint(['a', 'b'], 1), '成员集合变化必须改变指纹');
console.log('[1/6] 成员指纹确定性与敏感性验证通过');

// ---------------------------------------------------------------------------
// 2. 继承匹配：重映射 / 未命中 / 缺指纹 / 空摘要 / 一对一
// ---------------------------------------------------------------------------

const memberSet = ['a', 'b'];
const oldRecords = [
  { communityId: 'old-1', level: 1, summary: '旧摘要甲', keyPoints: [], entities: [], tokens: 5, memberFingerprint: computeCommunityMemberFingerprint(memberSet, 1) },
  { communityId: 'old-2', level: 1, summary: '旧摘要乙', keyPoints: [], entities: [], tokens: 5 },
  { communityId: 'old-3', level: 1, summary: '   ', keyPoints: [], entities: [], tokens: 0, memberFingerprint: computeCommunityMemberFingerprint(['x'], 1) },
];
const inheritance = inheritReusableSummaries({
  oldRecords,
  newCommunities: [
    { communityId: 'new-1', level: 1, memberKeys: ['b', 'a'] },
    { communityId: 'new-2', level: 1, memberKeys: ['a', 'b'] },
    { communityId: 'new-3', level: 1, memberKeys: ['a', 'changed'] },
    { communityId: 'new-4', level: 1, memberKeys: ['x'] },
  ],
});
assert.equal(inheritance.preloaded.length, 1, '一条旧记录最多被一个新社区继承');
const inherited = inheritance.preloaded[0];
assert.deepEqual({ id: inherited.communityId, level: inherited.level, inherited: inherited.inherited, summary: inherited.summary, tokens: inherited.tokens },
  { id: 'new-1', level: 1, inherited: true, summary: '旧摘要甲', tokens: 5 }, '命中必须重映射到新社区并保留原摘要');
assert.ok(inheritance.pending.some((community) => community.communityId === 'new-2'), '同指纹的第二个新社区不得重复继承');
assert.ok(inheritance.pending.some((community) => community.communityId === 'new-3'), '成员变化的社区必须进待生成清单');
assert.ok(inheritance.pending.some((community) => community.communityId === 'new-4'), '空摘要的旧记录不得参与继承');
assert.ok(!inheritance.preloaded.some((record) => record.communityId === 'new-3' || record.communityId === 'new-4'), '未命中社区不得进入继承清单');
console.log('[2/6] 继承匹配规则验证通过');

// ---------------------------------------------------------------------------
// 3. 端到端：首次全量生成（无继承，产物带成员指纹）
// ---------------------------------------------------------------------------

const graphV1Dir = path.join(outDir, 'graph-v1');
writeGraphArtifacts(graphV1Dir,
  [
    { canonicalKey: 'a1', mention: '实体A1', type: 'concept', description: '描述A1。', degree: 1 },
    { canonicalKey: 'a2', mention: '实体A2', type: 'concept', description: '描述A2。', degree: 1 },
    { canonicalKey: 'b1', mention: '实体B1', type: 'concept', description: '描述B1。', degree: 1 },
    { canonicalKey: 'b2', mention: '实体B2', type: 'concept', description: '描述B2。', degree: 1 },
  ],
  [
    { sourceKey: 'a1', targetKey: 'a2', weight: 2, kinds: ['协作'], description: 'A1 与 A2 协作。' },
    { sourceKey: 'b1', targetKey: 'b2', weight: 1, kinds: ['依赖'], description: 'B1 依赖 B2。' },
  ],
  [
    { communityId: 'c0', level: 0, parentId: '', memberKeys: ['a1', 'a2', 'b1', 'b2'] },
    { communityId: 'cA', level: 1, parentId: 'c0', memberKeys: ['a1', 'a2'] },
    { communityId: 'cB', level: 1, parentId: 'c0', memberKeys: ['b1', 'b2'] },
  ],
);
const firstRun = summaryStub('首轮');
const v1Result = await generateCommunitySummaries({ graphDirectory: graphV1Dir, graphKey: 'v1', config, fingerprint: 'fp-1', callSummary: firstRun.callSummary });
assert.equal(firstRun.count(), 3, '首次全量必须为每个社区调用一次');
assert.equal(v1Result.report.counts.inherited, 0, '首次生成不得出现继承');
assert.ok(v1Result.summaries.every((record) => typeof record.memberFingerprint === 'string' && record.memberFingerprint.length > 0), '全部产物必须携带成员指纹');
console.log('[3/6] 首次全量生成验证通过');

// ---------------------------------------------------------------------------
// 4. 端到端：图重建后增量继承（成员未变零调用，成员变化重算）
// ---------------------------------------------------------------------------

const graphV2Dir = path.join(outDir, 'graph-v2');
writeGraphArtifacts(graphV2Dir,
  [
    { canonicalKey: 'a1', mention: '实体A1', type: 'concept', description: '描述A1。', degree: 1 },
    { canonicalKey: 'a2', mention: '实体A2', type: 'concept', description: '描述A2。', degree: 1 },
    { canonicalKey: 'b1', mention: '实体B1', type: 'concept', description: '描述B1。', degree: 1 },
    { canonicalKey: 'b3', mention: '实体B3', type: 'concept', description: '描述B3。', degree: 1 },
  ],
  [
    { sourceKey: 'a1', targetKey: 'a2', weight: 2, kinds: ['协作'], description: 'A1 与 A2 协作。' },
    { sourceKey: 'b1', targetKey: 'b3', weight: 1, kinds: ['依赖'], description: 'B1 依赖 B3。' },
  ],
  [
    { communityId: 'n0', level: 0, parentId: '', memberKeys: ['a1', 'a2', 'b1', 'b3'] },
    { communityId: 'nA', level: 1, parentId: 'n0', memberKeys: ['a2', 'a1'] },
    { communityId: 'nB', level: 1, parentId: 'n0', memberKeys: ['b1', 'b3'] },
  ],
);
const rebuildInheritance = inheritReusableSummaries({
  oldRecords: v1Result.summaries,
  newCommunities: [
    { communityId: 'n0', level: 0, memberKeys: ['a1', 'a2', 'b1', 'b3'] },
    { communityId: 'nA', level: 1, memberKeys: ['a2', 'a1'] },
    { communityId: 'nB', level: 1, memberKeys: ['b1', 'b3'] },
  ],
});
assert.deepEqual(rebuildInheritance.preloaded.map((record) => record.communityId), ['nA'], '成员未变的社区必须命中继承（communityId 重映射）');
assert.deepEqual(rebuildInheritance.pending.map((community) => community.communityId).sort(), ['n0', 'nB'], '成员变化与高层社区必须重算');

const secondRun = summaryStub('重建');
const v2Result = await generateCommunitySummaries({ graphDirectory: graphV2Dir, graphKey: 'v2', config, fingerprint: 'fp-1', preloaded: rebuildInheritance.preloaded, callSummary: secondRun.callSummary });
assert.equal(secondRun.count(), 2, '继承社区零调用：只重算受影响社区');
assert.equal(v2Result.report.counts.inherited, 1, '报告必须统计继承数');
assert.equal(v2Result.report.counts.summarized, 3, '全部社区必须有摘要');
const inheritedRecord = v2Result.summaries.find((record) => record.communityId === 'nA');
assert.equal(inheritedRecord.inherited, true, '继承记录必须标记 inherited');
const reusedSource = v1Result.summaries.find((record) => record.communityId === 'cA');
assert.deepEqual({ summary: inheritedRecord.summary, tokens: inheritedRecord.tokens, keyPoints: inheritedRecord.keyPoints },
  { summary: reusedSource.summary, tokens: reusedSource.tokens, keyPoints: reusedSource.keyPoints }, '继承必须原样保留摘要内容');
console.log('[4/6] 重建增量继承验证通过');

// ---------------------------------------------------------------------------
// 5. 高层装配引用继承摘要（超预算替换路径）
// ---------------------------------------------------------------------------

const graphOverflowDir = path.join(outDir, 'graph-overflow');
const hugeText = '长'.repeat(33000);
writeGraphArtifacts(graphOverflowDir,
  [
    { canonicalKey: 'h1', mention: '巨型实体', type: 'concept', description: hugeText, degree: 1 },
    { canonicalKey: 'h2', mention: '伴随实体', type: 'concept', description: '描述。', degree: 1 },
    { canonicalKey: 's1', mention: '普通实体一', type: 'concept', description: '描述。', degree: 1 },
    { canonicalKey: 's2', mention: '普通实体二', type: 'concept', description: '描述。', degree: 1 },
  ],
  [
    { sourceKey: 'h1', targetKey: 'h2', weight: 1, kinds: ['关联'], description: '' },
    { sourceKey: 's1', targetKey: 's2', weight: 1, kinds: ['关联'], description: '' },
  ],
  [
    { communityId: 'root', level: 0, parentId: '', memberKeys: ['h1', 'h2', 's1', 's2'] },
    { communityId: 'leafH', level: 1, parentId: 'root', memberKeys: ['h1', 'h2'] },
    { communityId: 'leafS', level: 1, parentId: 'root', memberKeys: ['s1', 's2'] },
  ],
);
const preloadedRecord = {
  communityId: 'leafH', level: 1, summary: '继承摘要甲', keyPoints: ['继承要点'], entities: [], tokens: 6,
  memberFingerprint: computeCommunityMemberFingerprint(['h1', 'h2'], 1), inherited: true,
};
const overflowRun = summaryStub('高层');
const overflowResult = await generateCommunitySummaries({ graphDirectory: graphOverflowDir, graphKey: 'v3', config, fingerprint: 'fp-1', preloaded: [preloadedRecord], callSummary: overflowRun.callSummary });
assert.equal(overflowRun.count(), 2, '继承的叶级社区不得再调用模型');
const rootCallText = overflowRun.texts.find((text) => text.includes('leafS') || text.includes('leafH'));
assert.ok(rootCallText, '高层社区必须照常装配上下文');
assert.ok(rootCallText.includes('继承摘要甲'), '高层超预算替换必须使用继承摘要');
assert.ok(!rootCallText.includes(hugeText.slice(0, 1000)), '超预算替换后不得再携带巨型明细');
const rootRecord = overflowResult.summaries.find((record) => record.communityId === 'root');
assert.ok(rootRecord && !rootRecord.inherited, '高层社区照常生成（不受继承影响）');
assert.ok(rootRecord.summary.includes('高层'), '高层摘要文本来自模型调用');
console.log('[5/6] 高层装配引用继承摘要验证通过');

// ---------------------------------------------------------------------------
// 6. 产物回读：指纹与继承标记持久化，报告统计正确
// ---------------------------------------------------------------------------

const readBack = readCommunitySummaryRecords(graphV2Dir);
assert.equal(readBack.length, 3, '产物必须完整回读');
const readInherited = readBack.find((record) => record.communityId === 'nA');
assert.equal(readInherited.inherited, true, '回读必须保留 inherited 标记');
assert.equal(readInherited.memberFingerprint, computeCommunityMemberFingerprint(['a1', 'a2'], 1), '回读必须保留成员指纹');
assert.ok(readBack.every((record) => typeof record.memberFingerprint === 'string' && record.memberFingerprint), '全部回读记录必须带指纹');
const report = readCommunitySummaryReport(graphV2Dir);
assert.deepEqual({ inherited: report.counts.inherited, summarized: report.counts.summarized, communities: report.counts.communities },
  { inherited: 1, summarized: 3, communities: 3 }, '报告统计必须包含继承数');
console.log('[6/6] 产物回读与报告验证通过');

console.log('verify-materials-graph-summary-incremental: 全部 6 段验证通过');
process.exit(0);
