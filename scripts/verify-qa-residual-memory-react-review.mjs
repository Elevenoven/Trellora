import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `verify-qa-residual-memory-react-review-${process.pid}-${Date.now()}`);
const outputs = {
  review: path.join(stagingRoot, 'reactResidualMemoryReview.cjs'),
  residual: path.join(stagingRoot, 'residualConversationBudget.cjs'),
  rolling: path.join(stagingRoot, 'assistantRollingSummary.cjs'),
  adapter: path.join(stagingRoot, 'currentNoteContextMemoryAdapter.cjs'),
  memory: path.join(stagingRoot, 'noteConversationMemory.cjs'),
};

assertTemporaryPath(stagingRoot);
try {
  await Promise.all([
    bundle('electron/knowledge/reactResidualMemoryReview.ts', outputs.review),
    bundle('electron/knowledge/residualConversationBudget.ts', outputs.residual),
    bundle('electron/knowledge/assistantRollingSummary.ts', outputs.rolling),
    bundle('electron/knowledge/currentNoteContextMemoryAdapter.ts', outputs.adapter),
    bundle('electron/knowledge/noteConversationMemory.ts', outputs.memory),
  ]);

  const reviewModule = await load(outputs.review);
  const residualModule = await load(outputs.residual);
  const rollingModule = await load(outputs.rolling);
  const adapterModule = await load(outputs.adapter);
  const memoryModule = await load(outputs.memory);
  const {
    REACT_RESIDUAL_MEMORY_ADAPTATION_REVIEW: review,
    assertReactConversationMemoryBoundary,
    collectReactConversationMemoryBoundaryViolations,
  } = reviewModule;
  const { calculateResidualConversationBudget } = residualModule;
  const {
    createDeterministicTurnDigest,
    emptyRollingSummaryPayload,
    mergeRollingSummaryPayload,
    renderConversationMemorySummary,
    renderRollingSummary,
  } = rollingModule;
  const {
    CurrentNoteContextMemoryAdapter,
    currentNoteMemoryMaterialToPromptSegment,
    projectCurrentNotePromptSegments,
  } = adapterModule;
  const { createCurrentNoteMemoryConversationMessage } = memoryModule;

  assert.equal(review.schemaVersion, 'react-residual-memory-review-v1');
  assert.equal(review.decision, 'defer-route-enforce');
  assert.deepEqual(review.sharedBoundary.reusable, ['residual-budget-math', 'checkpoint-semantic-contract']);
  assert.deepEqual(review.sharedBoundary.authoritativeState, ['search-plan', 'evidence-ledger', 'tool-trace']);
  for (const route of ['current-note', 'library']) {
    assert.equal(review.routes[route].residualBudget, 'reuse');
    assert.equal(review.routes[route].checkpointContract, 'defer');
    assert.equal(review.routes[route].qaStorage, 'forbidden');
    assert.ok(review.routes[route].blockers.length > 0);
    assert.ok(review.routes[route].requiredBeforeEnforce.length > 0);
  }

  const budget128 = calculateResidualConversationBudget({
    contextWindowTokens: 131_072,
    maxOutputTokens: 16_384,
    safetyReserveTokens: 4_096,
    optimizedNonConversationTokens: 20_000,
    checkpointTokens: 2_000,
    rawConversationTokens: 50_000,
  });
  const budget256 = calculateResidualConversationBudget({
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    safetyReserveTokens: 4_096,
    optimizedNonConversationTokens: 20_000,
    checkpointTokens: 2_000,
    rawConversationTokens: 50_000,
  });
  assert.equal(budget128.H, 88_592, 'ReAct 评审必须复用同一份 W/O/G/N/C/M/H 数学');
  assert.ok(budget256.H > budget128.H, '256K 的剩余窗口必须真实扩大，不能退回固定 M2');

  const contentHash = 'a'.repeat(64);
  const evidenceId = `evidence-${'b'.repeat(24)}`;
  const digest = createDeterministicTurnDigest({
    turnId: 'current-note-turn-1',
    turnSeq: 1,
    contentHash,
    question: '阶段 5 的边界是什么？',
    answer: '只共享纯能力，权威状态保持独立。',
    status: 'complete',
    evidenceIds: [evidenceId],
    plan: {
      planId: 'plan-current-note-phase5',
      version: 2,
      status: 'completed',
      activeGoalId: null,
      goals: [{
        goalId: 'goal-phase5',
        status: 'covered',
        evidenceBindings: [{ requirementId: 'requirement-phase5', evidenceIds: [evidenceId] }],
        conflictBindings: [],
      }],
    },
  });
  const payload = mergeRollingSummaryPayload(emptyRollingSummaryPayload(contentHash), contentHash, [digest]);
  const auditProjection = renderRollingSummary(payload);
  const conversationProjection = renderConversationMemorySummary(payload);
  assert.match(auditProjection, /plan=plan-current-note-phase5/u, '持久化审计投影仍须保留计划引用');
  assert.match(auditProjection, new RegExp(evidenceId, 'u'), '持久化审计投影仍须保留证据引用');
  assert.doesNotMatch(conversationProjection, /plan=/u, '会话摘要不得恢复旧 SearchPlan 状态');
  assert.doesNotMatch(conversationProjection, new RegExp(evidenceId, 'u'), '会话摘要不得冒充 Evidence Ledger');
  assert.equal(payload.turnDigests[0].planOutcome.planId, 'plan-current-note-phase5', 'Prompt 投影不得改写持久化权威记录');
  assert.deepEqual(payload.turnDigests[0].evidenceIds, [evidenceId], 'Prompt 投影不得删除持久化证据引用');

  const summaryMessage = createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: `会话摘要：${conversationProjection}` },
    { zone: 'conversation-summary', sourceId: 'rolling-summary:phase5', sourceVersion: '3', contentHash },
  );
  const userMessage = createCurrentNoteMemoryConversationMessage(
    { role: 'user', content: '最近一轮用户原文。' },
    { zone: 'conversation-hot', sourceId: 'turn-2', sourceVersion: 'v2', contentHash, turnId: 'turn-2', turnSeq: 2 },
  );
  const assistantMessage = createCurrentNoteMemoryConversationMessage(
    { role: 'assistant', content: '最近一轮助手原文。' },
    { zone: 'conversation-hot', sourceId: 'turn-2', sourceVersion: 'v2', contentHash, turnId: 'turn-2', turnSeq: 2 },
  );
  const memory = await new CurrentNoteContextMemoryAdapter([summaryMessage, userMessage, assistantMessage]).load({
    route: 'current-note',
    workspaceId: 'workspace-phase5',
    libraryId: 'library-phase5',
    noteId: '阶段5.md',
    sessionId: 'current-note-session-phase5',
    currentQuestion: '验证阶段 5。',
    snapshotId: 'snapshot-phase5',
    contentHash,
    budgets: { summaryTokens: 4_096, hotTokens: 4_096, recallTokens: 0 },
  });
  assert.doesNotThrow(() => assertReactConversationMemoryBoundary('current-note', memory.materials));
  assert.ok(memory.materials.every((material) => !material.provenance?.planId && !material.provenance?.evidenceIds?.length));

  const unsafePlanMaterial = {
    ...memory.materials[0],
    id: 'unsafe-plan-memory',
    provenance: { ...memory.materials[0].provenance, planId: 'plan-leak' },
  };
  assert.match(collectReactConversationMemoryBoundaryViolations('current-note', [unsafePlanMaterial]).join(' '), /SearchPlan/u);
  assert.throws(() => assertReactConversationMemoryBoundary('library', [{
    ...memory.materials.at(-1),
    id: 'unsafe-qa-table-memory',
    source: { ...memory.materials.at(-1).source, kind: 'qa-conversation-checkpoint' },
  }]), /不得复用 QA 存储身份/u);

  const memorySegments = memory.materials.map((material) => currentNoteMemoryMaterialToPromptSegment(material));
  const assembly = projectCurrentNotePromptSegments('decide', [
    ...memorySegments,
    segment('phase5-plan', 'search-plan', 'SearchPlan 当前版本', true, { sourceIds: ['plan-current-note-phase5'] }),
    segment('execution-trace', 'execution-trace', '当前轮工具轨迹', false, { goalIds: ['goal-phase5'] }),
    segment('phase5-evidence', 'evidence', '当前轮 Evidence Ledger 原文', true, { evidenceIds: [evidenceId] }),
    segment('phase5-question', 'question', '当前问题', true),
  ], {
    mode: 'enforce',
    scope: { workspaceId: 'workspace-phase5', libraryId: 'library-phase5', noteId: '阶段5.md', sessionId: 'current-note-session-phase5' },
    windowProfile: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      physicalSource: 'provider',
      productCeilingTokens: 131_072,
      effectiveContextTokens: 131_072,
      autoCompactAtTokens: 124_518,
      reservedOutputTokens: 16_384,
      safetyTokens: 4_096,
      warnings: [],
    },
    memory,
    stateVector: { snapshotId: 'snapshot-phase5', contentHash, planId: 'plan-current-note-phase5', memoryVersion: memory.version },
  }, 0);
  const conversationMaterials = assembly.envelope.materials.filter((material) => material.zone === 'conversation-summary' || material.zone === 'conversation-hot');
  assert.doesNotThrow(() => assertReactConversationMemoryBoundary('current-note', conversationMaterials));
  assert.ok(assembly.envelope.materials.some((material) => material.zone === 'agent-state' && material.provenance?.planId === 'plan-current-note-phase5'));
  assert.ok(assembly.envelope.materials.some((material) => material.zone === 'dynamic-evidence' && material.provenance?.evidenceIds?.includes(evidenceId)));

  const currentNoteSource = readFileSync(path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts'), 'utf8');
  const librarySource = readFileSync(path.join(rootDir, 'electron', 'knowledge', 'libraryPlanAgentGraph.ts'), 'utf8');
  const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  assert.doesNotMatch(currentNoteSource, /QaMemoryRepository|qa_memory_/u, 'current-note 不得复制 QA 表或 Repository');
  assert.doesNotMatch(librarySource, /QaMemoryRepository|qa_memory_/u, 'library 不得复制 QA 表或 Repository');
  assert.match(currentNoteSource, /CurrentNoteContextMemoryAdapter/u);
  assert.match(librarySource, /const ledger = new LibraryEvidenceLedger/u);
  assert.match(librarySource, /plan: state\.searchPlan/u);
  assert.match(librarySource, /evidence: ledger\.list\(\)/u);
  assert.match(mainSource, /const sessionId = createAssistantSessionId\(\);[\s\S]{0,1000}runLibraryPlanAgent/u, 'library 仍是逐轮临时 session，评审不得误判为可 enforce');

  console.log('QA residual memory ReAct Phase 5 adaptation review verification passed');
} finally {
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function segment(id, zone, text, protectedMaterial, links = {}) {
  return {
    id,
    zone,
    text,
    estimatedTokens: Math.max(1, text.length),
    priority: protectedMaterial ? 100 : 60,
    protected: protectedMaterial,
    compressStrategy: protectedMaterial ? 'none' : 'summarize',
    ...links,
  };
}

function bundle(relativePath, outfile) {
  return build({
    entryPoints: [path.join(rootDir, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', 'electron'],
  });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
