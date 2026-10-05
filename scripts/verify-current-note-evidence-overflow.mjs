import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-evidence-overflow');
const files = {
  graph: path.join(outDir, 'graph.cjs'),
  snapshot: path.join(outDir, 'snapshot.cjs'),
  memory: path.join(outDir, 'memory.cjs'),
};

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({
    stdin: {
      contents: "export * from './electron/knowledge/currentNoteAgentGraph.ts'; export * from './electron/knowledge/aiProviderError.ts';",
      resolveDir: rootDir,
      sourcefile: 'phase5-overflow-entry.ts',
    },
    outfile: files.graph,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: files.snapshot, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: files.memory, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }),
]);

const { runCurrentNoteAgent, DEFAULT_ALL_RETRIEVED_TURN_BUDGET, AiProviderError } = await import(pathToFileURL(files.graph).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(files.snapshot).href);
const { NoteConversationMemory } = await import(pathToFileURL(files.memory).href);
const scenario = JSON.parse(await fs.readFile(path.join(fixtureDir, 'scenario.json'), 'utf8'));
const phase5 = scenario.phase5Compression;
const markdown = createPhase5Markdown(phase5);
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/phase5-evidence-overflow.md',
  title: '阶段5溢出夹具',
  contentHash: sha256(markdown),
  markdown,
  headings: [{ id: 'phase5', level: 1, text: '阶段5全量证据', line: 1 }],
  revision: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
});

const overflowEvents = [];
let synthCalls = 0;
const overflowCompressionDriver = createCompressionDriver();
const providerOverflowDriver = createAgentDriver({
  async synthesize({ prompt }) {
    synthCalls += 1;
    if (synthCalls === 1) {
      throw new AiProviderError({
        code: 'AI_CONTEXT_OVERFLOW',
        message: '模型上下文长度超出服务商限制。',
        providerLimitTokens: 10_000,
      });
    }
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '溢出重排后依据当前快照完成合成。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
  },
});
const overflowResult = await runCurrentNoteAgent(createInput({
  memoryScopeKey: 'phase5:overflow:provider',
  driver: providerOverflowDriver,
  compressionDriver: overflowCompressionDriver,
  onToolEvent: (event) => overflowEvents.push(event),
}));
assert.equal(synthCalls, 2, `Provider context overflow 必须只允许一次重新排程重试。 synth=${synthCalls} compression=${overflowCompressionDriver.calls.length} stats=${JSON.stringify(overflowResult.agentStats)} prompt=${JSON.stringify(overflowResult.promptStats ?? null)} evidence=${overflowResult.evidence.length}`);
assert.equal(overflowResult.completeness, 'complete');
assert.ok(overflowResult.agentStats.modelCalls <= DEFAULT_ALL_RETRIEVED_TURN_BUDGET.maxModelCalls);
assert.ok(overflowEvents.every((event) => !('prompt' in event)), '公开工具事件不得暴露 Provider 请求体。');
assert.ok(overflowEvents.every((event) => !JSON.stringify(event).match(/[A-Z]:\\/u)), '公开工具事件不得暴露绝对路径。');

const stale = await runCurrentNoteAgent(createInput({
  memoryScopeKey: 'phase5:overflow:stale-before-start',
  isSnapshotCurrent: () => false,
  driver: createAgentDriver(),
  compressionDriver: createCompressionDriver(),
}));
assert.equal(stale.agentStats.stopReason, 'snapshot-stale');
assert.equal(stale.completeness, 'partial');

let becameStale = false;
const staleDuringCompression = await runCurrentNoteAgent(createInput({
  memoryScopeKey: 'phase5:overflow:stale-during-compression',
  isSnapshotCurrent: () => !becameStale,
  driver: createAgentDriver(),
  compressionDriver: {
    async compressBatch(input) {
      becameStale = true;
      return createArtifact(input.batch);
    },
  },
}));
assert.equal(staleDuringCompression.agentStats.stopReason, 'snapshot-stale');
assert.equal(staleDuringCompression.completeness, 'partial');

const cancelledController = new AbortController();
cancelledController.abort();
await assert.rejects(
  () => runCurrentNoteAgent(createInput({
    memoryScopeKey: 'phase5:overflow:cancelled',
    signal: cancelledController.signal,
    driver: createAgentDriver(),
    compressionDriver: createCompressionDriver(),
  })),
  (error) => error?.name === 'AbortError',
  '取消请求必须在进入压缩或 Provider 前停止。',
);

const boundedOverflow = await runCurrentNoteAgent(createInput({
  memoryScopeKey: 'phase5:overflow:bounded',
  driver: createAgentDriver(),
  compressionDriver: {
    async compressBatch() { throw new Error('阶段5溢出夹具永久失败。'); },
  },
  budget: { ...DEFAULT_ALL_RETRIEVED_TURN_BUDGET, maxCompressionRounds: 0, maxCompressionBatches: 1, maxEvidenceCompressionCalls: 1 },
}));
assert.equal(boundedOverflow.agentStats.stopReason, 'context-budget');
assert.equal(boundedOverflow.completeness, 'partial');
assert.ok(boundedOverflow.evidence.length > 0, '上下文溢出失败必须保留已读取原文的引用。');

console.log(JSON.stringify({
  ok: true,
  providerOverflowRetries: synthCalls,
  providerOverflowResult: overflowResult.completeness,
  staleBeforeStart: stale.agentStats.stopReason,
  staleDuringCompression: staleDuringCompression.agentStats.stopReason,
  cancellation: 'AbortError',
  boundedOverflow: boundedOverflow.completeness,
}, null, 2));

function createInput(options) {
  return {
    snapshot,
    question: '请核对当前笔记中的全部阶段5证据。',
    conversation: [],
    providerKind: 'ollama',
    model: 'phase5-overflow-fixture-model',
    contextWindowTokens: options.contextWindowTokens ?? 20_000,
    signal: options.signal ?? new AbortController().signal,
    driver: options.driver,
    memory: new NoteConversationMemory(),
    memoryScopeKey: options.memoryScopeKey,
    isSnapshotCurrent: options.isSnapshotCurrent ?? (() => true),
    onToolEvent: options.onToolEvent,
    assistantEvidenceProjectionMode: 'all-retrieved',
    evidenceCompressionMode: 'enforce',
    evidenceCompressionDriver: options.compressionDriver,
    budget: options.budget,
  };
}

function createAgentDriver(overrides = {}) {
  return {
    async decide() {
      return { type: 'tool', tool: 'search_note', arguments: { terms: [phase5.term], limit: phase5.blockCount }, publicRationale: '定位当前笔记中的全量证据块。' };
    },
    async synthesize({ prompt }) {
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return { type: 'answer', answer: '依据当前快照形成答案。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
    },
    ...overrides,
  };
}

function createCompressionDriver() {
  const driver = { calls: [], async compressBatch({ batch }) { driver.calls.push(batch.batchId); return createArtifact(batch); } };
  return driver;
}

function createArtifact(batch) {
  const text = '压'.repeat(Math.max(1, Math.floor(batch.sourceTokenCount * phase5.compressionTargetRatio)));
  return {
    artifactId: `compression-artifact-${sha256(batch.batchId).slice(0, 24)}`,
    batchId: batch.batchId,
    snapshotId: batch.snapshotId,
    contentHash: batch.contentHash,
    sourceEvidenceIds: [...batch.sourceEvidenceIds],
    sourceTokenCount: batch.sourceTokenCount,
    compressedTokenCount: text.length,
    reductionRatio: 1 - phase5.compressionTargetRatio,
    compressedSegments: [{ segmentId: `segment-${sha256(batch.batchId).slice(0, 12)}`, sourceEvidenceIds: [...batch.sourceEvidenceIds], text, preservedTopics: ['事实', '日期', '版本'] }],
    preservedConflicts: [],
    modelProfileId: 'ollama:phase5-overflow-fixture-model',
    compressionPolicyVersion: 'stage4-v1',
    createdAt: '2026-08-24T00:00:00.000Z',
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
