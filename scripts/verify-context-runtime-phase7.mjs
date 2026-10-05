import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-context-runtime-phase7-${process.pid}-${Date.now()}`);
const diagnosticsOutput = path.join(outDir, 'contextRuntimeObserve.cjs');
const preferencesOutput = path.join(outDir, 'appPreferences.cjs');

await Promise.all([
  bundle('electron/knowledge/contextRuntimeObserve.ts', diagnosticsOutput),
  bundle('electron/appPreferences.ts', preferencesOutput),
]);

const runtime = await import(pathToFileURL(diagnosticsOutput).href);
const preferencesModule = await import(pathToFileURL(preferencesOutput).href);
const { clearContextRuntimeObservations, getContextProjectionDiagnostics, observeContextRuntime } = runtime;
const { defaultAppPreferences, normalizeAppPreferences } = preferencesModule;

clearContextRuntimeObservations();
for (const effectiveTokens of [16_384, 32_768, 65_536, 131_072]) {
  const turnId = `phase7-turn-${effectiveTokens}`;
  const secret = `API_KEY_SECRET_${effectiveTokens}_原始提示词不得进入诊断`;
  const envelope = createEnvelope(turnId, effectiveTokens, secret);
  const observation = observeContextRuntime({
    mode: effectiveTokens === 16_384 ? 'observe' : 'enforce',
    envelope,
    sendPath: effectiveTokens === 16_384 ? 'legacy-observe' : 'projection-enforce',
    legacy: {
      combinedPrompt: `legacy:${secret}`,
      systemPrompt: 'legacy-system',
      userPrompt: `legacy-user:${secret}`,
    },
  });
  assert.ok(observation);
  const diagnostics = observation.report.diagnostics;
  assert.equal(diagnostics.turnId, turnId);
  assert.equal(diagnostics.window.effectiveTokens, effectiveTokens);
  assert.equal(diagnostics.window.availablePromptTokens, Math.max(0, effectiveTokens - 2_048 - 1_024));
  assert.ok(diagnostics.tokens.candidate > 0);
  assert.ok(diagnostics.tokens.final > 0);
  assert.ok(diagnostics.zones.some((zone) => zone.zone === 'stable-policy' && zone.channels.includes('system')));
  assert.ok(diagnostics.zones.some((zone) => zone.zone === 'dynamic-evidence' && zone.trusts.includes('untrusted-evidence')));
  assert.equal(diagnostics.stablePrefix.providerCacheHitClaimed, false);
  assert.ok(diagnostics.stablePrefix.fingerprint);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secret, 'u'));
  assert.doesNotMatch(JSON.stringify(observation.report), /API_KEY_SECRET/u);
  assert.deepEqual(getContextProjectionDiagnostics(turnId), diagnostics);
}
assert.equal(getContextProjectionDiagnostics('phase7-turn-16384')?.mode, 'observe');
assert.equal(getContextProjectionDiagnostics('phase7-turn-131072')?.mode, 'enforce');
assert.equal(observeContextRuntime({
  mode: 'off',
  envelope: createEnvelope('phase7-off', 16_384, 'not-sent'),
  legacy: { combinedPrompt: 'off', userPrompt: 'off' },
}), undefined);

assert.equal(defaultAppPreferences.assistantContextRuntimeMode, 'observe');
assert.equal(defaultAppPreferences.assistantContextRuntimeChatMode, 'inherit');
const normalized = normalizeAppPreferences({
  assistantContextRuntimeMode: 'enforce',
  assistantContextRuntimeChatMode: 'off',
  assistantContextRuntimeKnowledgeBaseMode: 'invalid',
  assistantContextRuntimeCurrentNoteDirectMode: 'observe',
  assistantContextRuntimeCurrentNoteReactMode: 'enforce',
});
assert.equal(normalized.assistantContextRuntimeMode, 'observe');
assert.equal(normalized.assistantContextRuntimeChatMode, 'inherit');
assert.equal(normalized.assistantContextRuntimeKnowledgeBaseMode, 'inherit');
assert.equal(normalized.assistantContextRuntimeCurrentNoteDirectMode, 'inherit');
assert.equal(normalized.assistantContextRuntimeCurrentNoteReactMode, 'inherit');

const mainSource = read('electron/main.ts');
const preloadSource = read('electron/preload.ts');
const rendererTypesSource = read('src/electron.d.ts');
const settingsSource = read('src/components/SettingsPanel.tsx');
const panelSource = read('src/components/KnowledgePanel.tsx');
assert.match(mainSource, /assistant-context-diagnostics:get/u);
assert.match(mainSource, /type: 'context-diagnostics'/u);
assert.match(mainSource, /MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_REACT_MODE/u);
assert.match(preloadSource, /getAssistantContextDiagnostics/u);
assert.match(rendererTypesSource, /ContextProjectionDiagnostics/u);
assert.doesNotMatch(settingsSource, /助手计划路由|上下文自适应|统一上下文运行模式|上下文路由回滚|记忆架构投影|记忆路由回滚/u);
assert.match(panelSource, /Context Envelope/u);
assert.match(panelSource, /不代表 Provider 已命中缓存/u);
assert.match(panelSource, /新建话题会结束当前上下文链/u);

console.log('Context runtime Phase 7 verification passed');

function createEnvelope(turnId, effectiveTokens, secret) {
  return {
    schemaVersion: 1,
    route: effectiveTokens === 16_384 ? 'chat' : effectiveTokens === 32_768 ? 'knowledge-base' : 'current-note',
    callKind: effectiveTokens === 16_384 ? 'chat' : 'direct',
    scope: { workspaceId: 'phase7-workspace', sessionId: `session-${effectiveTokens}`, turnId },
    windowProfile: {
      providerId: 'phase7-provider',
      modelId: `phase7-model-${effectiveTokens}`,
      physicalContextTokens: effectiveTokens,
      physicalSource: 'provider',
      productCeilingTokens: 131_072,
      userCapTokens: effectiveTokens,
      effectiveContextTokens: effectiveTokens,
      autoCompactAtTokens: Math.floor(effectiveTokens * 0.85),
      reservedOutputTokens: 2_048,
      safetyTokens: 1_024,
      warnings: [],
    },
    materials: [
      material('policy', 'stable-policy', 'system', 'trusted-policy', '稳定策略', true, 'none', true),
      material('evidence', 'dynamic-evidence', 'user', 'untrusted-evidence', secret, false, 'summary', false),
      material('question', 'current-request', 'user', 'untrusted-memory', '当前问题', true, 'none', false),
    ],
    invariants: ['trust-channel-v1', 'protected-material-v1', 'stable-prefix-v1'],
    stateVector: {},
  };
}

function material(id, zone, channel, trust, content, protectedMaterial, compressStrategy, prefixEligible) {
  return {
    id,
    zone,
    channel,
    trust,
    content,
    priority: protectedMaterial ? 100 : 60,
    protected: protectedMaterial,
    compressStrategy,
    source: { kind: 'phase7-fixture', id, version: 'v1' },
    stalePolicy: 'keep',
    overflowPolicy: protectedMaterial ? 'fail' : 'compress',
    cache: { stability: prefixEligible ? 'stable' : 'turn', prefixEligible },
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

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), 'utf8');
}
