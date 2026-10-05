import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-context-runtime-phase4-${process.pid}-${Date.now()}`);
const outputs = {
  adapter: path.join(outDir, 'currentNoteContextMemoryAdapter.cjs'),
  projector: path.join(outDir, 'planAwarePromptProjector.cjs'),
  memory: path.join(outDir, 'noteConversationMemory.cjs'),
  rolling: path.join(outDir, 'assistantRollingSummary.cjs'),
  estimator: path.join(outDir, 'tokenEstimator.cjs'),
};

await Promise.all([
  bundle('electron/knowledge/currentNoteContextMemoryAdapter.ts', outputs.adapter),
  bundle('electron/knowledge/planAwarePromptProjector.ts', outputs.projector),
  bundle('electron/knowledge/noteConversationMemory.ts', outputs.memory),
  bundle('electron/knowledge/assistantRollingSummary.ts', outputs.rolling),
  bundle('electron/knowledge/tokenEstimator.ts', outputs.estimator),
]);

const adapterModule = await import(pathToFileURL(outputs.adapter).href);
const projectorModule = await import(pathToFileURL(outputs.projector).href);
const memoryModule = await import(pathToFileURL(outputs.memory).href);
const rollingModule = await import(pathToFileURL(outputs.rolling).href);
const estimatorModule = await import(pathToFileURL(outputs.estimator).href);

const {
  CurrentNoteContextMemoryAdapter,
  currentNoteMemoryMaterialToPromptSegment,
  projectCurrentNotePromptSegments,
  resolveCurrentNoteMemoryBudgets,
} = adapterModule;
const { PlanAwarePromptProjector } = projectorModule;
const { createCurrentNoteMemoryConversationMessage } = memoryModule;
const { createRollingSummaryBudgetMetadata } = rollingModule;
const { estimateTokenCount } = estimatorModule;

const contentHash = 'a'.repeat(64);
const staleContentHash = 'b'.repeat(64);
const snapshotId = `snapshot-${'c'.repeat(24)}`;
const sessionId = 'assistant-session-phase4-fixture';
const summaryText = `会话摘要：头部标记-${'摘'.repeat(3_950)}-尾部标记`;
const messages = [
  createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: summaryText },
    { zone: 'conversation-summary', sourceId: 'rolling-summary:phase4', sourceVersion: '7', contentHash },
  ),
  createCurrentNoteMemoryConversationMessage(
    { role: 'user', content: `第一轮问题-${'问'.repeat(900)}` },
    { zone: 'conversation-hot', sourceId: 'turn-1', sourceVersion: 'v1', contentHash, turnId: 'turn-1', turnSeq: 1 },
  ),
  createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: `第一轮回答-${'答'.repeat(900)}` },
    { zone: 'conversation-hot', sourceId: 'turn-1', sourceVersion: 'v1', contentHash, turnId: 'turn-1', turnSeq: 1 },
  ),
  createCurrentNoteMemoryConversationMessage(
    { role: 'user', content: '第二轮问题-最新问题必须保留。' },
    { zone: 'conversation-hot', sourceId: 'turn-2', sourceVersion: 'v2', contentHash, turnId: 'turn-2', turnSeq: 2 },
  ),
  createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: '第二轮回答-最新回答必须保留。' },
    { zone: 'conversation-hot', sourceId: 'turn-2', sourceVersion: 'v2', contentHash, turnId: 'turn-2', turnSeq: 2 },
  ),
  createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: '旧快照摘要不得注入。' },
    { zone: 'conversation-summary', sourceId: 'rolling-summary:stale', sourceVersion: '1', contentHash: staleContentHash },
  ),
];
const budgets = resolveCurrentNoteMemoryBudgets(131_072);
assert.deepEqual(budgets, { summaryTokens: 4_096, hotTokens: 4_096, recallTokens: 0 });
const request = {
  route: 'current-note',
  workspaceId: 'workspace-phase4',
  libraryId: 'library-phase4',
  noteId: '阶段4.md',
  sessionId,
  currentQuestion: '阶段 4 如何保持快照不变量？',
  snapshotId,
  contentHash,
  budgets,
};
const memoryResult = await new CurrentNoteContextMemoryAdapter(messages).load(request);
const summaryMaterial = memoryResult.materials.find((material) => material.zone === 'conversation-summary');
assert.ok(summaryMaterial, 'Rolling Summary 必须是独立 Material');
assert.equal(summaryMaterial.content, summaryText, '4096 Token 显式预算内不得再裁成最后 800 字符');
assert.match(summaryMaterial.content, /头部标记/u);
assert.match(summaryMaterial.content, /尾部标记/u);
assert.equal(memoryResult.diagnostics.loadedSummaries, 1);
assert.equal(memoryResult.diagnostics.loadedTurns, 2);
assert.equal(memoryResult.diagnostics.staleItems, 1);
assert.ok(!memoryResult.materials.some((material) => material.content.includes('旧快照摘要')));
const hotMaterials = memoryResult.materials.filter((material) => material.zone === 'conversation-hot');
assert.equal(hotMaterials.length, 2);
assert.ok(hotMaterials.every((material) => /用户：/u.test(material.content)));
assert.match(hotMaterials.at(-1).content, /最新问题必须保留/u);
assert.match(hotMaterials.at(-1).content, /最新回答必须保留/u);

const tightResult = await new CurrentNoteContextMemoryAdapter(messages).load({
  ...request,
  budgets: { summaryTokens: 120, hotTokens: 180, recallTokens: 0 },
});
assert.ok(tightResult.materials.filter((material) => material.zone === 'conversation-summary')
  .every((material) => estimateTokenCount(material.content) <= 120));
assert.ok(tightResult.materials.filter((material) => material.zone === 'conversation-hot')
  .reduce((total, material) => total + estimateTokenCount(material.content), 0) <= 180);
assert.equal(createRollingSummaryBudgetMetadata(summaryText).estimatedTokens, estimateTokenCount(summaryText));

const runtimeProfile = {
  providerId: 'fixture-provider',
  modelId: 'fixture-model',
  physicalContextTokens: 131_072,
  physicalSource: 'model-catalog',
  productCeilingTokens: 131_072,
  effectiveContextTokens: 131_072,
  autoCompactAtTokens: 111_411,
  reservedOutputTokens: 16_384,
  safetyTokens: 4_096,
  warnings: [],
};
const runtime = (mode) => ({
  mode,
  scope: { workspaceId: 'workspace-phase4', libraryId: 'library-phase4', noteId: '阶段4.md', sessionId },
  windowProfile: runtimeProfile,
  memory: memoryResult,
  stateVector: { snapshotId, contentHash, planId: 'plan-phase4', memoryVersion: memoryResult.version },
});

const syntheticSegments = [
  promptSegment('policy', 'policy', '固定策略逐字节保留。', true),
  promptSegment('plan-identity', 'search-plan', 'planId=plan-phase4 planVersion=1 baseVersion=1 activeGoalId=goal-1 status=active', true, { sourceIds: ['plan-phase4'] }),
  promptSegment('coverage', 'coverage', 'req=req-1:1/1 evidenceIds=evidence-aaaaaaaaaaaaaaaaaaaaaaaa', true, { goalIds: ['goal-1'], requirementIds: ['req-1'] }),
  promptSegment('execution-trace', 'tool-observation', 'goalId=goal-1 summary=已读取原文', false, { goalIds: ['goal-1'] }),
  promptSegment('tool-result', 'tool-observation', '工具返回的当前快照观察。', false),
  promptSegment('evidence', 'evidence', 'evidence-aaaaaaaaaaaaaaaaaaaaaaaa\n当前笔记原文证据。', true, { evidenceIds: ['evidence-aaaaaaaaaaaaaaaaaaaaaaaa'] }),
  promptSegment('question', 'question', '阶段 4 如何保持快照不变量？', true),
  promptSegment('output-contract', 'output-contract', '只输出允许的结构。', true),
];
const mapped = projectCurrentNotePromptSegments('decide', syntheticSegments, runtime('enforce'), 4);
assert.equal(mapped.projection.pressureLevel, 4);
assert.equal(mapped.envelope.stateVector.snapshotId, snapshotId);
assert.equal(mapped.envelope.stateVector.contentHash, contentHash);
assert.equal(materialZone(mapped, 'plan-identity'), 'agent-state');
assert.equal(materialZone(mapped, 'coverage'), 'agent-state');
assert.equal(materialZone(mapped, 'execution-trace'), 'agent-state');
assert.equal(materialZone(mapped, 'tool-result'), 'tool-observation');
assert.equal(materialZone(mapped, 'evidence'), 'dynamic-evidence');
assert.equal(materialZone(mapped, 'question'), 'current-request');
assert.equal(mapped.envelope.materials.find((material) => material.source.id === 'execution-trace').source.kind, 'current-note-execution-trace');
assert.equal(mapped.envelope.materials.find((material) => material.source.id === 'tool-result').source.kind, 'current-note-tool-observation');
assert.ok(mapped.projection.serializedBudgetText.includes('[role:system]'));
assert.ok(mapped.projection.serializedBudgetText.includes('[role:user]'));
assert.match(mapped.projection.userPrompt.trimEnd(), /阶段 4 如何保持快照不变量？$/u, '当前问题必须位于 User 动态内容末端');

const projector = new PlanAwarePromptProjector();
const projectorInput = {
  callKind: 'decide',
  stablePrefix: '固定策略逐字节保留。',
  capsuleText: `snapshotId=${snapshotId}\ncontentHash=${contentHash}`,
  question: '阶段 4 如何保持快照不变量？',
  conversation: messages,
  evidence: [{
    evidenceId: 'evidence-aaaaaaaaaaaaaaaaaaaaaaaa',
    text: '当前笔记原文证据。',
    snapshotId,
    contentHash,
    lineFrom: 1,
    lineTo: 2,
  }],
  outputSchema: '{"type":"object"}',
};
const observeProjection = projector.build({ ...projectorInput, contextRuntime: runtime('observe') });
const enforceProjection = projector.build({ ...projectorInput, contextRuntime: runtime('enforce') });
const offProjection = projector.build({ ...projectorInput, contextRuntime: runtime('off') });
assert.equal(observeProjection.prompt, observeProjection.legacyPrompt, 'observe 必须保留旧发送路径');
assert.ok(observeProjection.contextProjection, 'observe 必须构建统一投影');
assert.notEqual(enforceProjection.prompt, enforceProjection.legacyPrompt, 'enforce 必须使用统一投影发送路径');
assert.ok(enforceProjection.contextEnvelope.materials.some((material) => material.zone === 'conversation-summary'));
assert.ok(enforceProjection.contextEnvelope.materials.filter((material) => material.zone === 'conversation-hot').length >= 1);
assert.equal(offProjection.contextProjection, undefined, 'off 必须回滚到旧 PlanAwarePromptProjector 路径');
assert.equal(offProjection.prompt, offProjection.legacyPrompt);

const pressureZero = projector.build({ ...projectorInput, projectionLevel: 0, contextRuntime: runtime('enforce') });
const pressureFour = projector.build({ ...projectorInput, projectionLevel: 4, contextRuntime: runtime('enforce') });
for (const segment of pressureZero.segments.filter((entry) => entry.protected)) {
  const first = pressureZero.contextEnvelope.materials.find((material) => material.id === `current-note-segment:${segment.id}`);
  const second = pressureFour.contextEnvelope.materials.find((material) => material.id === `current-note-segment:${segment.id}`);
  assert.equal(first?.content, second?.content, `受保护 Segment ${segment.id} 在压力级别间必须逐字节一致`);
}
assert.equal(pressureFour.contextProjection.pressureLevel, 4);

const allRetrieved = projector.build({
  ...projectorInput,
  callKind: 'synthesize',
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'off',
  maxPromptTokens: 30_000,
  snapshotId,
  contentHash,
  contextRuntime: runtime('enforce'),
});
assert.equal(allRetrieved.evidencePromptManifest.representationCoverage, 1);
assert.deepEqual(allRetrieved.evidencePromptManifest.missingEvidenceIds, []);
assert.ok(allRetrieved.contextEnvelope.materials.some((material) => material.zone === 'dynamic-evidence'
  && material.provenance?.evidenceIds?.includes('evidence-aaaaaaaaaaaaaaaaaaaaaaaa')));
assert.throws(() => projector.build({
  ...projectorInput,
  contentHash: staleContentHash,
  contextRuntime: runtime('enforce'),
}), /contentHash/u, '旧快照材料不得进入新 Runtime');

const adapterSource = read('electron/knowledge/currentNoteContextMemoryAdapter.ts');
const projectorSource = read('electron/knowledge/planAwarePromptProjector.ts');
const repositorySource = read('electron/knowledge/assistantMemoryRepository.ts');
const graphSource = read('electron/knowledge/currentNoteAgentGraph.ts');
const actionSource = read('electron/knowledge/structuredActionDriver.ts');
assert.doesNotMatch(adapterSource, /\.prepare\s*\(|SELECT\s|INSERT\s|UPDATE\s|DELETE\s/iu, 'Adapter 不得拥有 SQL');
assert.match(projectorSource, /currentNoteMemoryMaterialToPromptSegment/u, '统一路径必须绕过旧的每消息 800 字符回滚投影');
assert.match(projectorSource, /input\.contextRuntime\.mode !== 'off'/u);
assert.match(repositorySource, /rollingSummaryBudget/u);
assert.match(repositorySource, /COALESCE\(finished_at, created_at\) AS source_version/u);
assert.match(graphSource, /MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_MODE/u);
assert.match(graphSource, /maxDecisionRounds: 10/u);
assert.match(graphSource, /maxModelCalls: 12/u);
assert.match(graphSource, /maxToolCalls: 10/u);
assert.match(graphSource, /finalSynthesisReserveMs: 60_000/u);
assert.match(actionSource, /non-executable model payload is the model's final answer/u);
assert.doesNotMatch(actionSource, /citations\.length\s*===\s*0.*throw/su, '不得新增强制引用门禁');

console.log('Context runtime Phase 4 verification passed');

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(rootDir, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
}

function promptSegment(id, zone, text, protectedSegment, links = {}) {
  return {
    id,
    zone,
    text,
    estimatedTokens: estimateTokenCount(text),
    priority: protectedSegment ? 100 : 60,
    protected: protectedSegment,
    compressStrategy: protectedSegment ? 'none' : 'dedupe',
    snapshotId,
    contentHash,
    ...links,
  };
}

function materialZone(assembly, sourceId) {
  return assembly.envelope.materials.find((material) => material.source.id === sourceId)?.zone;
}

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), 'utf8');
}
