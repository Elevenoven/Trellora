import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-evidence-compression');
const files = {
  graph: path.join(outDir, 'graph.cjs'),
  snapshot: path.join(outDir, 'snapshot.cjs'),
  memory: path.join(outDir, 'memory.cjs'),
  planner: path.join(outDir, 'planner.cjs'),
};

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: files.graph, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: files.snapshot, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: files.memory, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'evidenceCompressionPlanner.ts')], outfile: files.planner, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET, DEFAULT_ALL_RETRIEVED_TURN_BUDGET } = await import(pathToFileURL(files.graph).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(files.snapshot).href);
const { NoteConversationMemory } = await import(pathToFileURL(files.memory).href);
const { planEvidenceCompressionBatches } = await import(pathToFileURL(files.planner).href);

const scenario = JSON.parse(await fs.readFile(path.join(fixtureDir, 'scenario.json'), 'utf8'));
const phase5 = scenario.phase5Compression;
assert.equal(phase5.blockCount, 20, '阶段5必须使用全量 20 个命中块夹具。');
assert.equal(phase5.maxCompressionCalls, 5);
assert.equal(phase5.maxCompressionRounds, 2);
assert.equal(phase5.maxCompressionBatches, 6);

const markdown = createPhase5Markdown(phase5);
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/phase5-evidence-compression.md',
  title: '阶段5全量证据压缩夹具',
  contentHash: sha256(markdown),
  markdown,
  headings: [{ id: 'phase5', level: 1, text: '阶段5全量证据', line: 1 }],
  revision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
});

// The graph bundle keeps the cache injectable; this fixture uses a structural
// in-memory implementation so cache behavior remains deterministic.
const sharedCache = createMemoryCache();
const compressionState = { calls: [], fail: false };
const compressionDriver = createCompressionDriver(compressionState);
const publicToolEvents = [];

const first = await runAgent({
  snapshot,
  cache: sharedCache,
  compressionDriver,
  publicToolEvents,
  memoryScopeKey: 'phase5:compression:first',
});
assert.ok(compressionState.calls.length > 0, 'E01/E02：原文超出完整 Prompt 预算后必须执行压缩。');
assert.ok(compressionState.calls.length <= phase5.maxCompressionCalls, 'E05：压缩调用不得超过 5 次。');
assert.ok(first.synthPrompts.some((prompt) => prompt.includes('[compressed-unit]')), 'E02：最终合成必须同时包含压缩单元。');
assert.ok(first.synthPrompts.some((prompt) => countEvidenceIds(prompt) >= phase5.blockCount), 'E03：最终 Prompt 必须覆盖全部原 evidenceId。');
assert.equal(first.result.completeness, 'complete', '完整压缩成功时不得降级答案。');
assert.ok(first.result.agentStats.modelCalls <= DEFAULT_ALL_RETRIEVED_TURN_BUDGET.maxModelCalls, 'E05：总模型调用不得超过阶段5上限。');
assert.ok(first.publicToolEvents.every((event) => !JSON.stringify(event).includes('providerConfig')), 'E07：公开工具事件不得携带 Provider 请求体。');
assert.ok(first.publicToolEvents.every((event) => !JSON.stringify(event).match(/[A-Z]:\\/u)), 'E07：公开工具事件不得携带绝对路径。');

const compressedSourceText = first.compressionCalls[0]?.evidence[0]?.text;
if (compressedSourceText) assert.doesNotMatch(first.finalPrompt, new RegExp(escapeRegExp(compressedSourceText.slice(0, 120)), 'u'), 'E02：已经物化为压缩单元的原文不得重复发送。');

const callsAfterFirst = compressionState.calls.length;
const second = await runAgent({
  snapshot,
  cache: sharedCache,
  compressionDriver,
  memoryScopeKey: 'phase5:compression:first',
});
assert.equal(compressionState.calls.length, callsAfterFirst, 'E04：相同快照、问题和来源批次必须命中 Artifact 缓存。');
assert.ok(second.finalPrompt.includes('[compressed-unit]'), 'E04：缓存命中后仍必须重新渲染压缩单元。');

const advisoryCompressionState = { calls: [], fail: false, retentionRatio: 0.75 };
const advisoryRatio = await runAgent({
  snapshot,
  cache: createMemoryCache(),
  compressionDriver: createCompressionDriver(advisoryCompressionState),
  memoryScopeKey: 'phase5:compression:advisory-ratio',
});
assert.ok(advisoryRatio.compressionCalls.length > 0, '低于30%的合法压缩结果仍必须进入压缩流程。');
assert.ok(advisoryRatio.synthPrompts.length > 0, '低于目标比例时仍必须继续到最终合成或受控收敛。');
assert.ok(advisoryRatio.compressionCalls.every((call) => call.reductionRatio < 0.30), 'fixture 必须覆盖低于30%的实际压缩比例。');

const rawOnly = await runAgent({
  snapshot,
  cache: createMemoryCache(),
  compressionDriver,
  memoryScopeKey: 'phase5:compression:raw-only',
  evidenceCompressionMode: 'off',
  contextWindowTokens: 60_000,
});
assert.equal(compressionState.calls.length, callsAfterFirst, 'E01：原文可放入预算时不得调用压缩模型。');
assert.doesNotMatch(rawOnly.finalPrompt, /\[compressed-unit\]/u, 'E01：raw-fit 路径不得改变为压缩 Prompt。');
assert.ok(countEvidenceIds(rawOnly.finalPrompt) >= phase5.blockCount, 'E01：raw-fit 路径仍须发送全部原 evidenceId。');

const secondRoundUnit = {
  evidenceId: 'compression-artifact-stage5-round1',
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  textHash: 'artifact-text-hash',
  text: '压'.repeat(1_100),
  headingPath: ['阶段5全量证据'],
  lineFrom: 2,
  lineTo: 4,
  goalIds: [],
  firstSeenSeq: 1,
  representedEvidenceIds: ['evidence-source-a', 'evidence-source-b'],
};
const secondRoundBatches = planEvidenceCompressionBatches({
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  evidence: [secondRoundUnit],
  overflowTokens: 200,
  targetReductionRatio: 0.35,
  protectedEvidenceIds: [],
  maxSourceTokensPerBatch: 2_000,
});
assert.equal(secondRoundBatches.length, 1, 'E06：第二轮必须能以 Artifact 作为 source unit 重新成批。');
assert.deepEqual(secondRoundBatches[0].sourceUnitIds, [secondRoundUnit.evidenceId]);
assert.deepEqual(secondRoundBatches[0].sourceEvidenceIds, secondRoundUnit.representedEvidenceIds);

const failure = await runAgent({
  snapshot,
  cache: createMemoryCache(),
  compressionDriver: createCompressionDriver({ calls: [], fail: true }),
  memoryScopeKey: 'phase5:compression:failure',
  budget: { ...DEFAULT_ALL_RETRIEVED_TURN_BUDGET, maxCompressionRounds: 0, maxCompressionBatches: 1, maxEvidenceCompressionCalls: 1 },
});
assert.equal(failure.result.completeness, 'partial', 'E07：压缩永久失败必须返回 partial。');
assert.ok(failure.result.evidence.length > 0, 'E07：压缩失败不得静默丢弃原文证据。');
assert.equal(failure.result.agentStats.stopReason, 'context-budget');

console.log(JSON.stringify({
  ok: true,
  evidenceBlocks: phase5.blockCount,
  compressionCalls: compressionState.calls.length,
  firstModelCalls: first.result.agentStats.modelCalls,
  firstToolCalls: first.result.toolStats.calls,
  cacheHitVerified: true,
  secondRoundVerified: true,
  boundedFailure: failure.result.completeness,
}, null, 2));

async function runAgent(options) {
  const synthPrompts = [];
  let decisionCalls = 0;
  let snapshotCurrent = true;
  const driver = {
    async decide() {
      decisionCalls += 1;
      return {
        type: 'tool',
        tool: 'search_note',
        arguments: { terms: [phase5.term], limit: phase5.blockCount },
        publicRationale: '定位当前笔记中的全量证据块。',
      };
    },
    async synthesize({ prompt }) {
      synthPrompts.push(prompt);
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return {
        type: 'answer',
        answer: '已依据当前快照中的全量证据形成答案。',
        citations: evidenceId ? [evidenceId] : [],
        completeness: 'complete',
      };
    },
  };
  const result = await runCurrentNoteAgent({
    snapshot,
    question: '请核对当前笔记中的全部阶段5证据。',
    conversation: [],
    providerKind: 'ollama',
    model: 'phase5-fixture-model',
    contextWindowTokens: options.contextWindowTokens ?? 20_000,
    signal: new AbortController().signal,
    driver,
    memory: new NoteConversationMemory(),
    memoryScopeKey: options.memoryScopeKey,
    isSnapshotCurrent: () => snapshotCurrent,
    onToolEvent: (event) => options.publicToolEvents?.push(event),
    assistantEvidenceProjectionMode: 'all-retrieved',
    evidenceCompressionMode: options.evidenceCompressionMode ?? 'enforce',
    evidenceCompressionDriver: options.compressionDriver,
    evidenceCompressionCache: options.cache,
    budget: options.budget,
  });
  return { result, synthPrompts, finalPrompt: synthPrompts.at(-1) ?? '', compressionCalls: options.compressionDriver?.calls ?? [], publicToolEvents: options.publicToolEvents ?? [], decisionCalls, snapshotCurrent };
}

function createCompressionDriver(state) {
  const driver = {
    calls: state.calls,
    async compressBatch({ batch, evidence }) {
      if (state.fail) throw new Error('阶段5夹具压缩失败。');
      const retentionRatio = state.retentionRatio ?? phase5.compressionTargetRatio;
      state.calls.push({ batchId: batch.batchId, sourceEvidenceIds: [...batch.sourceEvidenceIds], reductionRatio: 1 - retentionRatio, evidence: evidence.map((record) => ({ ...record })) });
      const text = '压'.repeat(Math.max(1, Math.floor(batch.sourceTokenCount * retentionRatio)));
      return {
        artifactId: `compression-artifact-${sha256(batch.batchId).slice(0, 24)}`,
        batchId: batch.batchId,
        snapshotId: batch.snapshotId,
        contentHash: batch.contentHash,
        sourceEvidenceIds: [...batch.sourceEvidenceIds],
        sourceTokenCount: batch.sourceTokenCount,
        compressedTokenCount: Math.max(1, Math.floor(batch.sourceTokenCount * retentionRatio)),
        reductionRatio: 1 - retentionRatio,
        compressedSegments: [{ segmentId: `segment-${sha256(batch.batchId).slice(0, 12)}`, sourceEvidenceIds: [...batch.sourceEvidenceIds], text, preservedTopics: ['事实', '日期', '版本', '条件'] }],
        preservedConflicts: [],
        modelProfileId: 'phase5-fixture-model',
        compressionPolicyVersion: 'stage5-fixture-v1',
        createdAt: '2026-08-24T00:00:00.000Z',
      };
    },
  };
  return driver;
}

function createMemoryCache() {
  const entries = new Map();
  return {
    get(stateVector) { return entries.get(JSON.stringify(stateVector)); },
    set(stateVector, artifact) { entries.set(JSON.stringify(stateVector), artifact); },
  };
}

function createPhase5Markdown(config) {
  const padding = '原文事实日期版本条件例外实现方式。'.repeat(35);
  const blocks = Array.from({ length: config.blockCount }, (_, index) => {
    const id = String(index + 1).padStart(2, '0');
    return `${config.term} block-${id}：阶段5全量证据块 ${id} 记录事实、日期 2026-08-24、版本 5.${id}，并保留条件、例外和实现方式。\n${padding}`;
  });
  return `# 阶段5全量证据\n\n${blocks.join('\n\n')}`;
}

function countEvidenceIds(prompt) {
  return new Set([...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0])).size;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
