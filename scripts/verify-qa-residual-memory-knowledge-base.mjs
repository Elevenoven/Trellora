import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `verify-qa-residual-memory-knowledge-base-${process.pid}-${Date.now()}`);
const bundleDir = path.join(stagingRoot, 'bundles');
const bundles = {
  database: path.join(bundleDir, 'qaMemoryDatabase.cjs'),
  repository: path.join(bundleDir, 'qaMemoryRepository.cjs'),
  orchestrator: path.join(bundleDir, 'qaMemoryOrchestrator.cjs'),
  enforcer: path.join(bundleDir, 'qaResidualMemoryEnforcer.cjs'),
  assistantTurn: path.join(bundleDir, 'assistantTurn.cjs'),
  coordinator: path.join(bundleDir, 'modelCallCoordinator.cjs'),
  gate: path.join(bundleDir, 'modelCallBudget.cjs'),
};
let owner;

try {
  mkdirSync(bundleDir, { recursive: true });
  await Promise.all([
    bundle('electron/knowledge/qaMemoryDatabase.ts', bundles.database),
    bundle('electron/knowledge/qaMemoryRepository.ts', bundles.repository),
    bundle('electron/knowledge/qaMemoryOrchestrator.ts', bundles.orchestrator),
    bundle('electron/knowledge/qaResidualMemoryEnforcer.ts', bundles.enforcer),
    bundle('electron/knowledge/assistantTurn.ts', bundles.assistantTurn),
    bundle('electron/knowledge/modelCallCoordinator.ts', bundles.coordinator),
    bundle('electron/knowledge/modelCallBudget.ts', bundles.gate),
  ]);
  const { QaMemoryDatabase } = await import(pathToFileURL(bundles.database).href);
  const { QaMemoryRepository } = await import(pathToFileURL(bundles.repository).href);
  const { QaMemoryOrchestrator } = await import(pathToFileURL(bundles.orchestrator).href);
  const { QaResidualMemoryEnforcer } = await import(pathToFileURL(bundles.enforcer).href);
  const { createQaContextRuntimeAssembly } = await import(pathToFileURL(bundles.assistantTurn).href);
  const { ModelCallCoordinator } = await import(pathToFileURL(bundles.coordinator).href);
  const { ModelCallBudgetGate } = await import(pathToFileURL(bundles.gate).href);
  owner = new QaMemoryDatabase();

  const runCase = async (name, callback) => {
    const workspace = path.join(stagingRoot, name);
    mkdirSync(workspace, { recursive: true });
    const repository = new QaMemoryRepository(owner, workspace);
    await callback({ workspace, repository });
  };

  await runCase('evidence-yields-residual-space', async ({ workspace, repository }) => {
    const smallSessionId = 'assistant-session-41000000-0000-4000-8000-000000000001';
    const largeSessionId = 'assistant-session-41000000-0000-4000-8000-000000000002';
    for (const sessionId of [smallSessionId, largeSessionId]) {
      repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: workspace });
      for (let seq = 1; seq <= 12; seq += 1) addTurn(repository, sessionId, seq, `Q${seq}-${'q'.repeat(360)}`, `A${seq}-${'a'.repeat(1_200)}`);
    }
    const small = await enforceKnowledgeBase({
      workspace,
      repository,
      sessionId: smallSessionId,
      sources: [parentSource(1, 500)],
      contextWindowTokens: 32_768,
      createQaContextRuntimeAssembly,
      QaResidualMemoryEnforcer,
    });
    const large = await enforceKnowledgeBase({
      workspace,
      repository,
      sessionId: largeSessionId,
      sources: [parentSource(1, 11_000)],
      contextWindowTokens: 32_768,
      createQaContextRuntimeAssembly,
      QaResidualMemoryEnforcer,
    });
    assert.ok(small.result.diagnostics.evidence.actualTokens > 0);
    assert.ok(large.result.diagnostics.evidence.actualTokens > small.result.diagnostics.evidence.actualTokens);
    assert.ok(large.result.diagnostics.budget.N > small.result.diagnostics.budget.N, '证据增加必须先进入实际 N');
    assert.ok(large.result.diagnostics.budget.H < small.result.diagnostics.budget.H, '证据增加后仅动态收窄会话 H');
    assert.equal(small.result.diagnostics.conversation.rawTurnCount, 12);
    assert.equal(large.result.diagnostics.conversation.allRawTurnsIncluded, true);
  });

  await runCase('checkpoint-preserves-parent-evidence', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-42000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: workspace });
    for (let seq = 1; seq <= 14; seq += 1) {
      addTurn(repository, sessionId, seq, `P3-Q${seq}-${'q'.repeat(850)}`, `P3-A${seq}-${'a'.repeat(2_500)}${seq === 14 ? '-KB_RECENT_TAIL_SENTINEL' : ''}`);
    }
    const beforeTurns = fingerprintTurns(owner.getDatabase(workspace), sessionId);
    const enforced = await enforceKnowledgeBase({
      workspace,
      repository,
      sessionId,
      sources: [parentSource(1, 320), parentSource(2, 360)],
      contextWindowTokens: 16_384,
      createQaContextRuntimeAssembly,
      QaResidualMemoryEnforcer,
    });
    assert.ok(enforced.result.diagnostics.compaction.triggered, '95% 后应按需压缩最旧会话前缀');
    assert.ok(enforced.result.diagnostics.compaction.memoryWrites > 0);
    assert.deepEqual(enforced.result.diagnostics.evidence.references, [1, 2]);
    assert.equal(enforced.result.diagnostics.evidence.materialCount, 2);
    assert.equal(enforced.result.diagnostics.evidence.parentIdentityCount, 2);
    assert.equal(enforced.result.diagnostics.evidence.contentPreserved, true);
    assert.equal(enforced.result.diagnostics.evidence.parentIdentityPreserved, true);
    assert.match(enforced.result.projection.userPrompt, /KB_PARENT_1_SENTINEL/u);
    assert.match(enforced.result.projection.userPrompt, /KB_PARENT_2_SENTINEL/u);
    assert.match(enforced.result.projection.userPrompt, /KB_RECENT_TAIL_SENTINEL/u);
    for (const material of enforced.assembly.envelope.materials.filter((item) => item.source.kind === 'knowledge-base-parent')) {
      const included = enforced.result.projection.included.find((item) => item.id === material.id);
      assert.ok(included, `父块材料不得被省略：${material.id}`);
      assert.equal(included.contentSha256, sha256(material.content));
      assert.equal(included.source.id, material.source.id);
      assert.equal(included.source.contentHash, material.source.contentHash);
    }
    assert.equal(fingerprintTurns(owner.getDatabase(workspace), sessionId), beforeTurns, 'checkpoint 不得改写知识库原始 Turn');
  });

  await runCase('final-evidence-and-budget-gates', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-43000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: workspace });
    addTurn(repository, sessionId, 1, 'Gate-Q', 'Gate-A');
    const enforced = await enforceKnowledgeBase({
      workspace,
      repository,
      sessionId,
      sources: [parentSource(1, 1_000), parentSource(2, 1_000)],
      contextWindowTokens: 131_072,
      createQaContextRuntimeAssembly,
      QaResidualMemoryEnforcer,
    });
    assert.equal(enforced.assembly.evidencePromptManifest.representationCoverage, 1);
    assert.deepEqual(enforced.assembly.evidencePromptManifest.missingEvidenceIds, []);
    const coordinator = new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 1 }), 131_072, 'react-turn');
    const prepared = coordinator.prepare({
      callKind: 'direct',
      prompt: [enforced.result.projection.systemPrompt, enforced.result.projection.userPrompt].join('\n\n'),
      serializedBudgetText: enforced.result.projection.serializedBudgetText,
      requestEnvelopeVersion: enforced.result.projection.requestEnvelopeVersion,
      evidencePromptManifest: enforced.assembly.evidencePromptManifest,
    });
    assert.equal(prepared.ready, true, '完整父块表示与预算均通过后才允许发送');

    const invalidManifest = {
      ...enforced.assembly.evidencePromptManifest,
      representedEvidenceIds: enforced.assembly.evidencePromptManifest.representedEvidenceIds.slice(0, 1),
      missingEvidenceIds: enforced.assembly.evidencePromptManifest.turnRetrievedEvidenceIds.slice(1),
      representationCoverage: 0.5,
    };
    const rejectingCoordinator = new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 1 }), 131_072, 'react-turn');
    assert.throws(() => rejectingCoordinator.prepare({
      callKind: 'direct',
      prompt: [enforced.result.projection.systemPrompt, enforced.result.projection.userPrompt].join('\n\n'),
      serializedBudgetText: enforced.result.projection.serializedBudgetText,
      requestEnvelopeVersion: enforced.result.projection.requestEnvelopeVersion,
      evidencePromptManifest: invalidManifest,
    }), /100% 表示覆盖/u);
  });

  await runCase('protected-evidence-hard-veto', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-43500000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: workspace });
    const assembly = createQaContextRuntimeAssembly({
      route: 'knowledge-base',
      callKind: 'direct',
      question: '受保护证据已超过窗口时必须拒绝。',
      sources: [parentSource(1, 500)],
      contextMemory: { version: 'phase4-hard-veto', materials: [policyMaterial()] },
      memoryZoneTokens: { rollingSummary: 0, shortTerm: 0 },
      skillInstructions: [],
      scope: { workspaceId: workspace, libraryId: workspace, sessionId, turnId: 'phase4-hard-veto' },
      windowProfile: windowProfile(16_384),
    });
    const oversizedContent = `[1] 受保护父块\nKB_OVERSIZED_PARENT_SENTINEL-${'证'.repeat(90_000)}`;
    const oversizedHash = sha256(oversizedContent);
    const envelope = {
      ...assembly.envelope,
      materials: assembly.envelope.materials.map((material) => material.source.kind === 'knowledge-base-parent'
        ? {
          ...material,
          content: oversizedContent,
          source: { ...material.source, contentHash: oversizedHash },
          provenance: { ...material.provenance, contentHash: oversizedHash },
        }
        : material),
    };
    let modelCalls = 0;
    const result = await new QaResidualMemoryEnforcer(repository, {
      generateJson: async () => { modelCalls += 1; return {}; },
    }).enforce({
      sessionId,
      envelope,
      model: 'phase4-test',
      providerConfig: providerConfig(16_384),
      calibrationMultiplier: 1,
    });
    assert.equal(modelCalls, 0, '没有可压缩会话时不得调用 checkpoint 模型');
    assert.equal(result.diagnostics.state, 'hard-veto');
    assert.match(result.projection.userPrompt, /KB_OVERSIZED_PARENT_SENTINEL/u);
    const included = result.projection.included.find((item) => item.source.kind === 'knowledge-base-parent');
    assert.equal(included.contentSha256, oversizedHash);
    assert.equal(included.source.id, 'document-1:parent-1');
    const coordinator = new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 1 }), 16_384, 'react-turn');
    const prepared = coordinator.prepare({
      callKind: 'direct',
      prompt: [result.projection.systemPrompt, result.projection.userPrompt].join('\n\n'),
      serializedBudgetText: result.projection.serializedBudgetText,
      requestEnvelopeVersion: result.projection.requestEnvelopeVersion,
    });
    assert.equal(prepared.ready, false, '受保护父块达到 100% 后必须由最终预算门拒绝');
    assert.equal(prepared.reason, 'context-budget');
  });

  await runCase('enforce-stops-legacy-batches', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-44000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: workspace });
    for (let seq = 1; seq <= 15; seq += 1) addTurn(repository, sessionId, seq, `Legacy-Q${seq}`, `Legacy-A${seq}`);
    assert.ok(repository.planPendingBatches(sessionId).length > 0, 'fixture 必须满足旧批摘要生成条件');
    const orchestrator = new QaMemoryOrchestrator(repository, () => undefined, workspace);
    const preparation = await orchestrator.prepareTurn({
      sessionId,
      scope: 'knowledge-base',
      turnId: 'phase4-pending-turn',
      userText: '继续',
      scopeLabel: '个人知识库',
      libraryPath: workspace,
      contextWindowTokens: 131_072,
      projectContext: { stablePolicy: '只依据资料回答。', version: 'phase4-policy-v1' },
      residualMemoryMode: 'enforce',
    });
    const summaryCount = owner.getDatabase(workspace).prepare('SELECT COUNT(*) AS count FROM qa_summaries WHERE session_id = ?').get(sessionId).count;
    assert.equal(summaryCount, 0, 'knowledge-base enforce 不得继续写旧 M1 批摘要');
    orchestrator.finishAbortedTurn(preparation.sessionId, preparation.turnId, 'cancelled');
    orchestrator.shutdown();
  });

  console.log('QA residual memory Phase 4 verification passed: evidence-first residual, parent identity/citation preservation, final evidence gate and legacy-batch stop');
} finally {
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

async function enforceKnowledgeBase(input) {
  const assembly = input.createQaContextRuntimeAssembly({
    route: 'knowledge-base',
    callKind: 'direct',
    question: '请依据父块回答当前问题。',
    sources: input.sources,
    contextMemory: { version: 'phase4-context-v1', materials: [policyMaterial()] },
    memoryZoneTokens: { rollingSummary: 0, shortTerm: 0 },
    skillInstructions: [],
    scope: { workspaceId: input.workspace, libraryId: input.workspace, sessionId: input.sessionId, turnId: `phase4-${input.sessionId}` },
    windowProfile: windowProfile(input.contextWindowTokens),
  });
  let modelCalls = 0;
  const result = await new input.QaResidualMemoryEnforcer(input.repository, {
    generateJson: async () => { modelCalls += 1; return {}; },
  }).enforce({
    sessionId: input.sessionId,
    envelope: assembly.envelope,
    model: 'phase4-test',
    providerConfig: providerConfig(input.contextWindowTokens),
    calibrationMultiplier: 1,
  });
  return { assembly, result, modelCalls };
}

function parentSource(reference, characters) {
  const content = `KB_PARENT_${reference}_SENTINEL\n${`父块${reference}原文内容。`.repeat(Math.ceil(characters / 8)).slice(0, characters)}`;
  return {
    title: `资料 ${reference} · 父块 ${reference}`,
    content,
    sourceId: `document-${reference}:parent-${reference}`,
    contentHash: sha256(content),
  };
}

function policyMaterial() {
  return {
    id: 'phase4-policy', zone: 'stable-policy', channel: 'system', trust: 'trusted-policy', content: '只依据本轮知识库父块资料回答。',
    priority: 100, protected: true, compressStrategy: 'none', source: { kind: 'policy', id: 'knowledge-base', version: '1' },
    stalePolicy: 'keep', overflowPolicy: 'fail', cache: { stability: 'stable', prefixEligible: true },
  };
}

function windowProfile(contextWindowTokens) {
  const reservedOutputTokens = contextWindowTokens <= 16_384 ? 2_048 : 4_096;
  const safetyTokens = contextWindowTokens < 131_072 ? Math.max(2_048, Math.floor(contextWindowTokens * 0.05)) : Math.floor(contextWindowTokens * 0.03125);
  return {
    providerId: 'custom', modelId: 'phase4-test', runtimeProfileId: contextWindowTokens === 131_072 ? '128k' : 'custom',
    physicalContextTokens: contextWindowTokens, physicalSource: 'user', productCapMode: 'follow-model', productCeilingTokens: contextWindowTokens,
    effectiveContextTokens: contextWindowTokens, autoCompactAtTokens: Math.floor(contextWindowTokens * 0.82),
    reservedOutputTokens, safetyTokens, warnings: [],
  };
}

function providerConfig(contextWindowTokens) {
  return {
    kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint: 'http://127.0.0.1:9',
    apiKey: 'fixture-only', model: 'phase4-test', contextWindowTokens, contextWindowTokensSource: 'user', remoteContentConsent: true,
  };
}

function addTurn(repository, sessionId, seq, userText, answer) {
  const turnId = `${sessionId}-turn-${seq}`;
  const started = repository.startTurn(sessionId, { turnId, userText, scopeLabel: '个人知识库' });
  assert.equal(started.turnSeq, seq);
  repository.finalizeTurn(sessionId, turnId, {
    type: 'answer', answer, provider: 'custom', model: 'phase4-test', sourceNotes: [], retrievalMode: 'hybrid', completeness: 'complete',
  });
}

function fingerprintTurns(database, sessionId) {
  const rows = database.prepare('SELECT turn_id, turn_seq, user_text, assistant_text, status, result_json FROM qa_turns WHERE session_id = ? ORDER BY turn_seq').all(sessionId);
  return sha256(JSON.stringify(rows));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(rootDir, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
  assert.equal(existsSync(outfile), true);
}
