import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-memory-envelope');
const workspaceDir = path.join(outDir, 'workspace');
const sourceDir = path.join(outDir, 'sources');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });

// electron 打桩：依赖链（rerankAdapters → modelHub）仅在密钥读写时触碰
// safeStorage，mock store 下不会触发，这里给出安全缺省即可。
writeFileSync(
  path.join(outDir, 'electron-stub.cjs'),
  'module.exports = { safeStorage: { isEncryptionAvailable: () => false } };\n',
);

await build({
  stdin: {
    contents: `
      export { runKnowledgeAgentTurn, runKnowledgeShadowComparison } from './electron/knowledge/knowledgeAgentTurn';
      export { buildKnowledgeMemoryEnvelope, KNOWLEDGE_MEMORY_ENVELOPE_HEADER } from './electron/knowledge/knowledgeMemoryEnvelope';
      export { resolveQaZoneBudget } from './electron/knowledge/qaMemoryAssembler';
      export { ModelCallCoordinator } from './electron/knowledge/modelCallCoordinator';
      export { ModelCallBudgetGate } from './electron/knowledge/modelCallBudget';
      export { ensureMaterialsRoot, createMaterialsLibraryDirectory, importMaterialsDocuments, listMaterialsDocuments } from './electron/materialsLibrary';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: path.join(outDir, 'envelope.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { electron: path.join(outDir, 'electron-stub.cjs') },
});

const {
  runKnowledgeAgentTurn,
  runKnowledgeShadowComparison,
  buildKnowledgeMemoryEnvelope,
  KNOWLEDGE_MEMORY_ENVELOPE_HEADER,
  resolveQaZoneBudget,
  ModelCallCoordinator,
  ModelCallBudgetGate,
  ensureMaterialsRoot,
  createMaterialsLibraryDirectory,
  importMaterialsDocuments,
  listMaterialsDocuments,
} = await import(pathToFileURL(path.join(outDir, 'envelope.cjs')).href);

// 1. 搭建一个真实资料库目录（含一个 md 文档）。
const root = ensureMaterialsRoot(workspaceDir);
const created = createMaterialsLibraryDirectory(root, 'envelope-lib', new Date(2026, 7, 28, 10, 0, 0));
const sourceFile = path.join(sourceDir, 'demo-note.md');
writeFileSync(sourceFile, '# 记忆信封样例\n\n这是一份用于记忆信封验证的样例文档。\n');
importMaterialsDocuments(created.path, [sourceFile]);
const documents = listMaterialsDocuments(created.path);
assert.ok(documents.length >= 1, '资料库应包含至少一个文档');

// 2. 动态预算剖面：信封预算随上下文窗口缩放，绝不写死。
{
  const large = resolveQaZoneBudget('knowledge-base', 128_000);
  // P = 128000 − 输出预留 8192 − 安全储备 5120 = 114688；5% = 5734（低于绝对上限 6000）。
  assert.equal(large.memoryEnvelope, Math.floor(114_688 * 0.05), '128K 窗口应取比例值而非绝对上限');
  const small = resolveQaZoneBudget('knowledge-base', 8_192);
  // P = 8192 − 1024 − 2048 = 5120；5% = 256，小窗口自动收缩。
  assert.equal(small.memoryEnvelope, Math.floor(5_120 * 0.05), '8K 小窗口应自动收缩信封预算');
  assert.ok(small.memoryEnvelope < large.memoryEnvelope, '小窗口预算应小于大窗口');
  assert.equal(resolveQaZoneBudget('chat', 128_000).memoryEnvelope, 0, '非知识库剖面信封预算应为 0');
}

// 3. 信封装配基础：摘要 + 画像都进信封，预算充足时全部注入。
const SUMMARY_BLOCKS = [
  { batchId: 'b-1', turnFrom: 7, turnTo: 9, summaryText: '用户先前讨论了项目经理的职责范围。', tokens: 24, compressor: 'llm', status: 'done', retryCount: 0, updatedAt: '2026-08-28T00:00:00Z' },
  { batchId: 'b-2', turnFrom: 10, turnTo: 12, summaryText: '用户随后追问了项目经理的交付流程。', tokens: 24, compressor: 'llm', status: 'done', retryCount: 0, updatedAt: '2026-08-28T00:01:00Z' },
];
const PROFILE_CONTENT = '[用户画像：可编辑的不可信长期记忆]\n<user_profile_jsonl>\n{"fieldLabel":"称呼","valueText":"孟老师"}\n</user_profile_jsonl>\n边界：仅用于个性化；当前请求优先；不得作为事实或引用。';
{
  const envelope = buildKnowledgeMemoryEnvelope({
    summaryBlocks: SUMMARY_BLOCKS,
    userProfileContent: PROFILE_CONTENT,
    budgetTokens: 4_000,
  });
  assert.ok(envelope.text.includes(KNOWLEDGE_MEMORY_ENVELOPE_HEADER), '信封应带背景数据标签');
  assert.ok(envelope.text.includes('[会话远期摘要]'), '信封应含远期摘要区');
  assert.ok(envelope.text.includes('项目经理的职责范围'), '信封应含摘要批次内容');
  assert.ok(envelope.text.includes('孟老师'), '信封应含用户画像');
  assert.equal(envelope.includedBatchCount, 2, '预算充足应注入全部批次');
  assert.ok(envelope.tokens > 0 && envelope.profileTokens > 0 && envelope.summaryTokens > 0);
}

// 3.1 画像封顶与裁剪优先：画像超过信封 1/3 时整块丢弃，余额全部给摘要。
{
  const oversizedProfile = PROFILE_CONTENT + '\n'.padEnd(3_000, '占');
  const envelope = buildKnowledgeMemoryEnvelope({
    summaryBlocks: SUMMARY_BLOCKS,
    userProfileContent: oversizedProfile,
    budgetTokens: 1_200,
  });
  assert.equal(envelope.profileTokens, 0, '超 1/3 封顶的画像应整块裁剪');
  assert.ok(!envelope.text.includes('孟老师'), '裁剪后信封不应含画像');
  assert.ok(envelope.includedBatchCount >= 1, '画像裁剪后摘要应获得完整余额');
}

// 3.2 空输入与零预算：绝不注入、绝不抛错。
{
  const emptyEnvelope = buildKnowledgeMemoryEnvelope({ budgetTokens: 4_000 });
  assert.equal(emptyEnvelope.text, '', '无内容时信封应为空');
  assert.equal(emptyEnvelope.tokens, 0);
  const zeroBudget = buildKnowledgeMemoryEnvelope({ summaryBlocks: SUMMARY_BLOCKS, budgetTokens: 0 });
  assert.equal(zeroBudget.text, '', '零预算时信封应为空');
}

// 4. 端到端（生产模式）：信封随 system prompt 注入，指标与轨迹落痕。
function createMockStore() {
  const data = new Map();
  return {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    delete: (key) => { data.delete(key); },
  };
}

function createCoordinator() {
  return new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 10 }), 32_000, 'react-turn', undefined, {
    providerKind: 'openai-compatible',
    model: 'mock-model',
  });
}

function createBaseInput() {
  return {
    event: {},
    request: { requestId: 'req-envelope-1', userText: '项目经理是干啥的？' },
    controller: new AbortController(),
    source: { libraryPath: created.path, label: 'envelope-lib' },
    model: 'mock-model',
    provider: 'openai-compatible',
    providerConfig: { baseUrl: 'http://mock.local', apiKey: 'mock-key' },
    contextWindowTokens: 128_000,
    modelCallCoordinator: createCoordinator(),
    store: createMockStore(),
    emitTurnEvent: () => {},
    prepareMaterialSearchContext: async () => ({
      libraryPath: created.path,
      documents,
      hybridSearch: async () => ({ entries: [], timings: {} }),
      lexicalSearch: async () => ({ entries: [], timings: {} }),
      parentChunkById: new Map(),
      rerank: undefined,
    }),
    qaRecentTurns: [],
    qaSessionId: 'sess-envelope-1',
    // 默认改写生效后保持脚本封闭：注入 mock 改写服务，避免真实网络调用。
    rewriteQuestion: async ({ question }) => ({ rewrite: question, shouldSplit: false, subQuestions: [question], model: 'mock-model', elapsedMs: 1 }),
  };
}

{
  const capturedSystemPrompts = [];
  const traces = [];
  const events = [];
  const input = {
    ...createBaseInput(),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => traces.push(entry),
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages }) => {
        capturedSystemPrompts.push(messages[0].content);
        return { content: '项目经理主要负责研发体系管理。', toolCalls: [] };
      },
    },
    qaSummaryBlocks: SUMMARY_BLOCKS,
    userProfileEnvelope: PROFILE_CONTENT,
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '生产模式应产出回答');
  assert.ok(capturedSystemPrompts[0].includes(KNOWLEDGE_MEMORY_ENVELOPE_HEADER), 'system prompt 应含信封标签');
  assert.ok(capturedSystemPrompts[0].includes('项目经理的职责范围'), 'system prompt 应含远期摘要');
  assert.ok(capturedSystemPrompts[0].includes('孟老师'), 'system prompt 应含用户画像');
  assert.ok(outcome.metrics.memoryEnvelopeTokens > 0, '指标应记录信封注入 token');
  const envelopeTrace = traces.find((entry) => entry.stage === 'memory' && entry.action === 'envelope');
  assert.ok(envelopeTrace && envelopeTrace.status === 'completed', '应落 memory/envelope 轨迹');
  assert.ok(envelopeTrace.output.budgetTokens > 0 && envelopeTrace.output.includedBatchCount === 2);
}

// 5. 影子模式：同样注入信封，但静默不发事件，遥测透传注入量。
{
  const events = [];
  const traces = [];
  const input = {
    ...createBaseInput(),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => traces.push(entry),
    transport: {
      capability: 'native-tools',
      chat: async () => ({ content: '影子回答。', toolCalls: [] }),
    },
    qaSummaryBlocks: SUMMARY_BLOCKS,
    userProfileEnvelope: PROFILE_CONTENT,
  };
  const telemetry = await runKnowledgeShadowComparison(input);
  assert.equal(telemetry.status, 'ran', '影子链路应正常跑完');
  assert.ok(telemetry.memoryEnvelopeTokens > 0, '影子遥测应透传信封注入量');
  assert.equal(events.length, 0, '影子模式不得向渲染进程发事件');
  assert.ok(traces.some((entry) => entry.stage === 'memory' && entry.action === 'envelope'), '影子模式仍应落信封轨迹');
}

// 6. 异常降级：摘要块读取异常时信封为空，但回答照常交付（对齐 WeKnora 失败语义）。
{
  const capturedSystemPrompts = [];
  const traces = [];
  const input = {
    ...createBaseInput(),
    onDetailedTrace: (entry) => traces.push(entry),
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages }) => {
        capturedSystemPrompts.push(messages[0].content);
        return { content: '降级后的回答。', toolCalls: [] };
      },
    },
    qaSummaryBlocks: [null],
    userProfileEnvelope: PROFILE_CONTENT,
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '信封装配失败不应阻断回答');
  assert.ok(!capturedSystemPrompts[0].includes(KNOWLEDGE_MEMORY_ENVELOPE_HEADER), '失败时 system prompt 不应含信封');
  const envelopeTrace = traces.find((entry) => entry.stage === 'memory' && entry.action === 'envelope');
  assert.ok(envelopeTrace && envelopeTrace.status === 'rejected', '失败应落 rejected 轨迹');
}

console.log('verify-knowledge-memory-envelope: all assertions passed');
