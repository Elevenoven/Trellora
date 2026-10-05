import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-qa-residual-memory-observe-${process.pid}-${Date.now()}`);
const files = {
  observe: path.join(outDir, 'observe.cjs'),
  window: path.join(outDir, 'window.cjs'),
};

await Promise.all([
  bundle('electron/knowledge/contextRuntimeObserve.ts', files.observe),
  bundle('shared/effectiveContextWindow.ts', files.window),
]);

const {
  clearContextRuntimeObservations,
  getContextProjectionDiagnostics,
  observeContextRuntime,
  observeContextRuntimeProviderUsage,
} = await import(pathToFileURL(files.observe).href);
const { resolveAssistantModelRuntimeProfile } = await import(pathToFileURL(files.window).href);

const turns = Array.from({ length: 70 }, (_, index) => createTurn(index + 1));
const memory = {
  memorableTurns: turns,
  legacy: {
    rollingSummaryTokens: 1_240,
    shortTermTokens: 3_680,
    summaryMaterialCount: 2,
    hotTurnSeqs: [65, 66, 67, 68, 69, 70],
  },
};

clearContextRuntimeObservations();
const reports = new Map();
for (const W of [131_072, 262_144]) {
  const profile = resolveAssistantModelRuntimeProfile({
    providerId: 'phase0-provider',
    modelId: `phase0-${W}`,
    discoveredModelWindow: W,
    discoveredSource: 'provider',
  });
  const envelope = createEnvelope(profile, `phase0-turn-${W}`);
  const observation = observeContextRuntime({
    mode: 'observe',
    envelope,
    sendPath: 'legacy-observe',
    legacy: {
      combinedPrompt: 'LEGACY_SYSTEM\n\nLEGACY_M1_M2_AND_CURRENT_REQUEST',
      systemPrompt: 'LEGACY_SYSTEM',
      userPrompt: 'LEGACY_M1_M2_AND_CURRENT_REQUEST',
    },
    qaResidualMemory: memory,
    calibrationMultiplier: 1.05,
  });
  assert.ok(observation);
  reports.set(W, observation.report);
  const residual = observation.report.diagnostics.residualMemory;
  assert.ok(residual);
  assert.equal(residual.observationOnly, true);
  assert.equal(residual.legacy.M1.tokens, 1_240);
  assert.equal(residual.legacy.M2.tokens, 3_680);
  assert.equal(residual.legacy.M2.turnCount, 6);
  assert.equal(residual.budget.W, W);
  assert.equal(residual.budget.M, 0, 'Phase 0 没有连续 checkpoint，不能把旧 M1 冒充为 M');
  assert.equal(residual.budget.C, Math.max(0, residual.budget.W - residual.budget.O - residual.budget.G - residual.budget.N));
  assert.equal(residual.budget.H, Math.max(0, residual.budget.C - residual.budget.M));
  assert.ok(residual.budget.UWindow > 0);
  assert.equal(observation.report.modelCallsAdded, 0);
  assert.equal(observation.report.memoryWritesAdded, 0);
  assert.equal(observation.report.turnStateMutations, 0);
  assert.doesNotMatch(JSON.stringify(observation.report.diagnostics), /PHASE0_PRIVATE_TURN/u);
}

const report128 = reports.get(131_072);
const report256 = reports.get(262_144);
assert.equal(report128.diagnostics.residualMemory.wouldOptimize.pressureLevel, 'P4');
assert.equal(report128.diagnostics.residualMemory.wouldCompact.candidate, true);
assert.ok(report128.diagnostics.residualMemory.wouldCompact.compactThroughTurnSeq > 0);
assert.equal(report128.diagnostics.residualMemory.wouldInclude.allRawTurns, false);
assert.equal(report256.diagnostics.window.runtimeProfileId, '256k');
assert.equal(report256.diagnostics.residualMemory.wouldOptimize.pressureLevel, 'P0');
assert.equal(report256.diagnostics.residualMemory.wouldCompact.candidate, false);
assert.equal(report256.diagnostics.residualMemory.wouldInclude.allRawTurns, true);
assert.equal(report256.diagnostics.residualMemory.wouldInclude.turnCount, turns.length);
assert.ok(report256.diagnostics.residualMemory.budget.H > report128.diagnostics.residualMemory.budget.H);

observeContextRuntimeProviderUsage({
  report: report256,
  responseCompleted: true,
  usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112, cachedInputTokens: 20 },
  localRawInputTokens: 80,
  localCalibratedInputTokens: 84,
  calibrationMultiplierUsed: 1.05,
});
const usage = report256.diagnostics.providerUsage;
assert.equal(usage.reported, true);
assert.equal(usage.providerInputTokens, 100);
assert.equal(usage.rawEstimateSignedErrorTokens, -20);
assert.equal(usage.rawEstimateAbsoluteErrorTokens, 20);
assert.equal(usage.rawEstimateRelativeError, 0.2);
assert.equal(usage.calibratedEstimateSignedErrorTokens, -16);
assert.equal(getContextProjectionDiagnostics('phase0-turn-262144').providerUsage.providerInputTokens, 100);

rmSync(outDir, { recursive: true, force: true });
console.log('QA residual memory Phase 0 observe verification passed: 128K/256K, W/O/G/N/C/M/H, would-* and Provider usage error');

function createEnvelope(windowProfile, turnId) {
  return {
    schemaVersion: 1,
    route: 'chat',
    callKind: 'chat',
    scope: { workspaceId: 'phase0-workspace', sessionId: 'phase0-session', turnId },
    windowProfile,
    materials: [
      material('policy', 'stable-policy', 'system', 'trusted-policy', '固定策略', true),
      material('legacy-m1', 'conversation-summary', 'user', 'untrusted-memory', '旧 M1 实际投影', false),
      material('legacy-m2', 'conversation-hot', 'user', 'untrusted-memory', '旧 M2 实际投影', false),
      material('question', 'current-request', 'user', 'untrusted-memory', '当前问题', true),
    ],
    invariants: ['trust-channel-v1', 'protected-material-v1', 'stable-prefix-v1'],
    stateVector: {},
  };
}

function material(id, zone, channel, trust, content, protectedMaterial) {
  return {
    id,
    zone,
    channel,
    trust,
    content,
    priority: protectedMaterial ? 100 : 60,
    protected: protectedMaterial,
    compressStrategy: protectedMaterial ? 'none' : 'summary',
    source: { kind: 'phase0-fixture', id, version: 'v1' },
    stalePolicy: 'keep',
    overflowPolicy: protectedMaterial ? 'fail' : 'compress',
    cache: { stability: protectedMaterial ? 'stable' : 'session', prefixEligible: zone === 'stable-policy' },
  };
}

function createTurn(turnSeq) {
  return {
    turnId: `turn-${turnSeq}`,
    turnSeq,
    userText: `PHASE0_PRIVATE_TURN_${turnSeq}_问题`,
    assistantText: `PHASE0_PRIVATE_TURN_${turnSeq}_${'长会话'.repeat(600)}`,
    scopeLabel: '直接聊天',
    status: 'complete',
    createdAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:00:01.000Z',
  };
}

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(rootDir, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
}
