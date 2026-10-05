import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `verify-qa-residual-memory-enforce-${process.pid}-${Date.now()}`);
const bundleDir = path.join(stagingRoot, 'bundles');
const bundles = {
  database: path.join(bundleDir, 'qaMemoryDatabase.cjs'),
  repository: path.join(bundleDir, 'qaMemoryRepository.cjs'),
  enforcer: path.join(bundleDir, 'qaResidualMemoryEnforcer.cjs'),
  coordinator: path.join(bundleDir, 'modelCallCoordinator.cjs'),
  gate: path.join(bundleDir, 'modelCallBudget.cjs'),
  observe: path.join(bundleDir, 'contextRuntimeObserve.cjs'),
};
let owner;

try {
  mkdirSync(bundleDir, { recursive: true });
  await Promise.all([
    bundle('electron/knowledge/qaMemoryDatabase.ts', bundles.database),
    bundle('electron/knowledge/qaMemoryRepository.ts', bundles.repository),
    bundle('electron/knowledge/qaResidualMemoryEnforcer.ts', bundles.enforcer),
    bundle('electron/knowledge/modelCallCoordinator.ts', bundles.coordinator),
    bundle('electron/knowledge/modelCallBudget.ts', bundles.gate),
    bundle('electron/knowledge/contextRuntimeObserve.ts', bundles.observe),
  ]);
  const { QaMemoryDatabase } = await import(pathToFileURL(bundles.database).href);
  const { QaMemoryRepository } = await import(pathToFileURL(bundles.repository).href);
  const { QaResidualMemoryEnforcer } = await import(pathToFileURL(bundles.enforcer).href);
  const { ModelCallCoordinator } = await import(pathToFileURL(bundles.coordinator).href);
  const { ModelCallBudgetGate } = await import(pathToFileURL(bundles.gate).href);
  const { observeContextRuntime } = await import(pathToFileURL(bundles.observe).href);
  owner = new QaMemoryDatabase();

  const runCase = async (name, callback) => {
    const workspace = path.join(stagingRoot, name);
    mkdirSync(workspace, { recursive: true });
    const repository = new QaMemoryRepository(owner, workspace);
    await callback({ workspace, repository });
  };

  await runCase('window-128k', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-12800000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'chat');
    for (let seq = 1; seq <= 20; seq += 1) addTurn(repository, sessionId, seq, `128K-Q${seq}-${'q'.repeat(900)}`, `128K-A${seq}-${'a'.repeat(3_200)}`);
    const before = fingerprintTurns(owner.getDatabase(workspace), sessionId);
    let modelCalls = 0;
    const enforcer = new QaResidualMemoryEnforcer(repository, { generateJson: async () => { modelCalls += 1; return {}; } });
    const result = await enforcer.enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 131_072),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 131_072),
      calibrationMultiplier: 1,
    });
    assert.equal(modelCalls, 0, '低于 95% 时不得调用 checkpoint 模型');
    assert.equal(repository.getConversationCheckpoint(sessionId), undefined);
    assertPreparedObservation(observeContextRuntime, result);
    assert.equal(result.diagnostics.conversation.rawTurnCount, 20);
    assert.ok(result.diagnostics.conversation.rawTokens > 12_000, '128K 原始尾部应能超过旧 12K M2');
    assert.equal(result.projection.included.filter((item) => item.zone === 'conversation-hot').length, 20);
    assert.equal(fingerprintTurns(owner.getDatabase(workspace), sessionId), before, '投影不得修改完整 Turn');
  });

  let h128 = 0;
  await runCase('window-256k', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-25600000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'chat');
    for (let seq = 1; seq <= 20; seq += 1) addTurn(repository, sessionId, seq, `256K-Q${seq}-${'q'.repeat(900)}`, `256K-A${seq}-${'a'.repeat(3_200)}`);
    const result128 = await new QaResidualMemoryEnforcer(repository, { generateJson: async () => ({}) }).enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 131_072),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 131_072),
      calibrationMultiplier: 1,
    });
    h128 = result128.diagnostics.budget.H;
    const result256 = await new QaResidualMemoryEnforcer(repository, { generateJson: async () => ({}) }).enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 262_144),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 262_144),
      calibrationMultiplier: 1,
    });
    assert.ok(result256.diagnostics.budget.H > h128, '256K 的原始会话余量必须大于 128K');
    assert.equal(result256.diagnostics.conversation.rawTurnCount, 20);
  });

  await runCase('p1-before-p3', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-31000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'chat');
    for (let seq = 1; seq <= 5; seq += 1) addTurn(repository, sessionId, seq, `P1-Q${seq}-${'q'.repeat(400)}`, `P1-A${seq}-${'a'.repeat(1_300)}`);
    const duplicate = '可安全去重的非会话证据 '.repeat(3_600);
    const extras = Array.from({ length: 8 }, (_, index) => evidenceMaterial(`duplicate-${index}`, duplicate));
    let modelCalls = 0;
    const result = await new QaResidualMemoryEnforcer(repository, { generateJson: async () => { modelCalls += 1; return {}; } }).enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 32_768, extras),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 32_768),
      calibrationMultiplier: 1,
    });
    assert.ok(result.pressureEpisode.actions.some((action) => action.level === 'P1' && action.releasedTokens > 0));
    assert.ok(result.diagnostics.budget.UWindow < 0.95);
    assert.equal(result.diagnostics.compaction.triggered, false, 'P1/P2 足够时不得压缩会话');
    assert.equal(modelCalls, 0);
    assert.equal(repository.getConversationCheckpoint(sessionId), undefined);
    assertPreparedObservation(observeContextRuntime, result);
  });

  await runCase('p3-checkpoint', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-32000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'chat');
    for (let seq = 1; seq <= 14; seq += 1) {
      addTurn(repository, sessionId, seq, `P3-Q${seq}-${'q'.repeat(900)}`, `P3-A${seq}-${'a'.repeat(2_700)}${seq === 14 ? '-RECENT_RAW_TAIL_SENTINEL' : ''}`);
    }
    const before = fingerprintTurns(owner.getDatabase(workspace), sessionId);
    let modelCalls = 0;
    const result = await new QaResidualMemoryEnforcer(repository, {
      generateJson: async () => { modelCalls += 1; return {}; },
    }).enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 16_384),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 16_384),
      calibrationMultiplier: 1,
    });
    const checkpoint = repository.getConversationCheckpoint(sessionId);
    assert.ok(checkpoint, 'P3 应提交单一 checkpoint');
    assert.equal(modelCalls, 2, '严格 JSON 只重试一次，第三次使用 fallback');
    assert.equal(result.diagnostics.compaction.attempts, 3);
    assert.equal(result.diagnostics.compaction.fallbackUsed, true);
    assert.equal(result.diagnostics.compaction.memoryWrites, 1);
    assert.ok(checkpoint.summaryTokens <= checkpoint.sourceTokens * 0.20);
    assert.ok(result.diagnostics.state === 'compacted' || result.diagnostics.state === 'pressure-degraded');
    assert.match(result.projection.userPrompt, /RECENT_RAW_TAIL_SENTINEL/u, '最近原始尾部必须逐字保留');
    assert.equal(fingerprintTurns(owner.getDatabase(workspace), sessionId), before, 'checkpoint 提交不得修改完整 Turn');
    assertPreparedObservation(observeContextRuntime, result);
  });

  await runCase('p4-final-veto', async ({ workspace, repository }) => {
    const sessionId = 'assistant-session-34000000-0000-4000-8000-000000000001';
    repository.ensureSession(sessionId, 'chat');
    const oversizedCurrentRequest = currentRequest(`CURRENT_REQUEST_SENTINEL-${'x'.repeat(90_000)}`);
    const result = await new QaResidualMemoryEnforcer(repository, { generateJson: async () => ({}) }).enforce({
      sessionId,
      envelope: envelope(workspace, sessionId, 16_384, [oversizedCurrentRequest], false),
      model: 'phase3-test',
      providerConfig: providerConfig('phase3-test', 16_384),
      calibrationMultiplier: 1,
    });
    assert.equal(result.diagnostics.state, 'hard-veto');
    assert.match(result.projection.userPrompt, /CURRENT_REQUEST_SENTINEL/u, '当前问题不得被截断');
    const coordinator = new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 1 }), 16_384, 'react-turn');
    const prepared = coordinator.prepare({
      callKind: 'chat',
      prompt: [result.projection.systemPrompt, result.projection.userPrompt].join('\n\n'),
      serializedBudgetText: result.projection.serializedBudgetText,
      requestEnvelopeVersion: result.projection.requestEnvelopeVersion,
    });
    assert.equal(prepared.ready, false, '100% 溢出必须被最终 ModelCallCoordinator veto');
    assert.equal(prepared.reason, 'context-budget');
  });

  console.log('QA residual memory Phase 3 verification passed: 128K/256K residual, P1-before-P3, foreground checkpoint, verbatim tail and final veto');
} finally {
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

function envelope(workspace, sessionId, contextWindowTokens, extras = [], includeDefaultRequest = true) {
  const output = contextWindowTokens <= 16_384 ? 2_048 : 8_192;
  const safety = contextWindowTokens < 131_072 ? Math.max(2_048, Math.floor(contextWindowTokens * 0.05)) : Math.floor(contextWindowTokens * 0.03125);
  return {
    schemaVersion: 1,
    route: 'chat',
    callKind: 'chat',
    scope: { workspaceId: workspace, sessionId, turnId: `turn-${Date.now()}` },
    windowProfile: {
      providerId: 'custom',
      modelId: 'phase3-test',
      runtimeProfileId: contextWindowTokens === 131_072 ? '128k' : contextWindowTokens === 262_144 ? '256k' : 'custom',
      physicalContextTokens: contextWindowTokens,
      physicalSource: 'user',
      productCapMode: 'follow-model',
      productCeilingTokens: contextWindowTokens,
      effectiveContextTokens: contextWindowTokens,
      autoCompactAtTokens: Math.floor(contextWindowTokens * 0.82),
      reservedOutputTokens: output,
      safetyTokens: safety,
      warnings: [],
    },
    materials: [policyMaterial(), ...extras, ...(includeDefaultRequest ? [currentRequest('当前问题：继续')] : [])],
    invariants: ['trust-channel-v1', 'protected-material-v1'],
    stateVector: {},
  };
}

function policyMaterial() {
  return {
    id: 'policy', zone: 'stable-policy', channel: 'system', trust: 'trusted-policy', content: '你是本地笔记助手。',
    priority: 100, protected: true, compressStrategy: 'none', source: { kind: 'policy', id: 'chat', version: '1' },
    stalePolicy: 'keep', overflowPolicy: 'fail', cache: { stability: 'stable', prefixEligible: true },
  };
}

function currentRequest(content) {
  return {
    id: 'request', zone: 'current-request', channel: 'user', trust: 'untrusted-memory', content,
    priority: 100, protected: true, compressStrategy: 'none', source: { kind: 'request', id: 'chat', version: '1' },
    stalePolicy: 'refresh', overflowPolicy: 'fail', cache: { stability: 'turn', prefixEligible: false },
  };
}

function evidenceMaterial(id, content) {
  return {
    id, zone: 'dynamic-evidence', channel: 'user', trust: 'untrusted-evidence', content,
    priority: 20, protected: false, compressStrategy: 'reference', source: { kind: 'fixture-evidence', id, version: '1' },
    lifecycle: { rereadable: true, status: 'completed' }, stalePolicy: 'keep', overflowPolicy: 'drop',
    cache: { stability: 'turn', prefixEligible: false },
  };
}

function providerConfig(model, contextWindowTokens) {
  return {
    kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint: 'http://127.0.0.1:9',
    apiKey: 'fixture-only', model, contextWindowTokens, contextWindowTokensSource: 'user', remoteContentConsent: true,
  };
}

function addTurn(repository, sessionId, seq, userText, answer) {
  const turnId = `phase3-turn-${seq}`;
  const started = repository.startTurn(sessionId, { turnId, userText, scopeLabel: '直接聊天' });
  assert.equal(started.turnSeq, seq);
  repository.finalizeTurn(sessionId, turnId, {
    type: 'answer', answer, provider: 'custom', model: 'phase3-test', sourceNotes: [], retrievalMode: 'none', completeness: 'complete',
  });
}

function fingerprintTurns(database, sessionId) {
  const rows = database.prepare(`SELECT turn_id, turn_seq, user_text, assistant_text, status, result_json FROM qa_turns WHERE session_id = ? ORDER BY turn_seq`).all(sessionId);
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function assertPreparedObservation(observeContextRuntime, result) {
  const observation = observeContextRuntime({
    mode: 'enforce',
    envelope: result.envelope,
    sendPath: 'projection-enforce',
    legacy: { combinedPrompt: 'legacy', systemPrompt: '', userPrompt: 'legacy' },
    preparedProjection: result.projection,
    preparedAdmission: result.admission,
    preparedPressureEpisode: result.pressureEpisode,
    qaResidualMemoryEnforcement: result.diagnostics,
  });
  assert.ok(observation?.projection);
  assert.deepEqual(observation.report.invariantViolations, []);
  assert.equal(observation.report.diagnostics.residualMemoryEnforcement.state, result.diagnostics.state);
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
