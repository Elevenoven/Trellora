import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `context-runtime-phase2-${process.pid}-${Date.now()}`);
const outputs = {
  window: path.join(stagingRoot, 'effective-window.cjs'),
  scheduler: path.join(stagingRoot, 'scheduler.cjs'),
  gate: path.join(stagingRoot, 'gate.cjs'),
  coordinator: path.join(stagingRoot, 'coordinator.cjs'),
  renderer: path.join(stagingRoot, 'renderer.cjs'),
  ollama: path.join(stagingRoot, 'ollama.cjs'),
};

assertTemporaryPath(stagingRoot);
mkdirSync(stagingRoot, { recursive: true });
let server;
try {
  await Promise.all([
    bundle('shared/effectiveContextWindow.ts', outputs.window),
    bundle('electron/knowledge/currentNoteContextBudget.ts', outputs.scheduler),
    bundle('electron/knowledge/modelCallBudget.ts', outputs.gate),
    bundle('electron/knowledge/modelCallCoordinator.ts', outputs.coordinator),
    bundle('electron/knowledge/contextRenderer.ts', outputs.renderer),
    bundle('electron/knowledge/ollamaClient.ts', outputs.ollama),
  ]);

  const { resolveEffectiveContextWindow } = await load(outputs.window);
  const { PromptBudgetScheduler } = await load(outputs.scheduler);
  const { ModelCallBudgetGate } = await load(outputs.gate);
  const { MaintenanceModelCallCoordinator, ModelCallCoordinator } = await load(outputs.coordinator);
  const { serializeContextRoleMessagesForBudget } = await load(outputs.renderer);
  const { generateOllamaText } = await load(outputs.ollama);

  const scheduler = new PromptBudgetScheduler();
  for (const tokens of [16_384, 32_768, 65_536, 131_072, 262_144]) {
    const window = resolveEffectiveContextWindow({ discoveredModelWindow: tokens, discoveredSource: 'provider' });
    assert.equal(window.tokens, tokens);
    assert.equal(window.runtimeProfile.effectiveContextTokens, tokens);
    assert.ok(window.runtimeProfile.autoCompactAtTokens >= Math.floor(tokens * 0.8));
    assert.ok(window.runtimeProfile.autoCompactAtTokens <= Math.ceil(tokens * 0.85));
    const plan = scheduler.plan({ prompt: '阶段二窗口门禁', contextWindowTokens: tokens, callKind: 'direct' });
    assert.equal(plan.maxPromptTokens + plan.maxOutputTokens + plan.safetyReserveTokens, tokens);
    assert.ok(plan.predictedPromptTokens + plan.maxOutputTokens + plan.safetyReserveTokens <= tokens);
  }
  assert.equal(resolveEffectiveContextWindow({ discoveredModelWindow: 131_072, discoveredSource: 'provider' }).runtimeProfile.runtimeProfileId, '128k');
  assert.equal(resolveEffectiveContextWindow({ discoveredModelWindow: 262_144, discoveredSource: 'provider' }).runtimeProfile.runtimeProfileId, '256k');

  const unsupported128k = resolveEffectiveContextWindow({
    discoveredModelWindow: 32_768,
    discoveredSource: 'provider',
    configuredModelWindow: 131_072,
    knownModelWindow: 131_072,
  });
  assert.equal(unsupported128k.tokens, 32_768, '不支持 128K 的模型不得继续声明 128K');
  assert.equal(unsupported128k.source, 'provider');
  assert.match(unsupported128k.warning ?? '', /采用较小值/u);

  const unknown = resolveEffectiveContextWindow();
  assert.equal(unknown.tokens, 200_000);
  assert.equal(unknown.source, 'conservative-default');
  assert.equal(unknown.confidence, 'estimated');
  assert.equal(unknown.runtimeProfile.runtimeProfileId, 'conservative-200k');
  assert.match(unknown.warning ?? '', /未识别模型/u);

  const explicitUserCap = resolveEffectiveContextWindow({ configuredModelWindow: 65_536 });
  assert.equal(explicitUserCap.tokens, 65_536);
  assert.equal(explicitUserCap.source, 'configured');
  assert.match(explicitUserCap.warning ?? '', /请确认模型实际支持/u);

  const followModel = resolveEffectiveContextWindow({ discoveredModelWindow: 200_000, discoveredSource: 'provider' });
  assert.equal(followModel.tokens, 200_000);
  assert.equal(followModel.runtimeProfile.productCapMode, 'follow-model');

  const productCapped = resolveEffectiveContextWindow({
    applicationCeiling: 131_072,
    discoveredModelWindow: 262_144,
    discoveredSource: 'provider',
  });
  assert.equal(productCapped.tokens, 131_072);
  assert.match(productCapped.warning ?? '', /产品上限/u);

  const legacy = resolveEffectiveContextWindow({ mode: 'legacy-fixed-128k', discoveredModelWindow: 32_768 });
  assert.equal(legacy.tokens, 131_072);
  assert.equal(legacy.source, 'application-fixed');
  assert.match(legacy.warning ?? '', /Legacy Fixed128K/u);

  const serializedBudgetText = serializeContextRoleMessagesForBudget('SYSTEM_POLICY', 'USER_EVIDENCE', []);
  const rolePlan = scheduler.plan({
    prompt: 'SYSTEM_POLICY\n\nUSER_EVIDENCE',
    serializedBudgetText,
    requestEnvelopeVersion: 'context-envelope-v1',
    contextWindowTokens: 16_384,
    callKind: 'chat',
  });
  assert.equal(rolePlan.budgetTextSource, 'serialized-envelope');
  assert.equal(rolePlan.requestEnvelopeVersion, 'context-envelope-v1');
  assert.ok(rolePlan.rawPromptTokens >= scheduler.plan({ prompt: 'USER_EVIDENCE', contextWindowTokens: 16_384, callKind: 'chat' }).rawPromptTokens);

  let calibrationKey;
  const calibrationStore = {
    getMultiplier(key) {
      calibrationKey = key;
      return 1.05;
    },
  };
  const interactiveGate = new ModelCallBudgetGate({ maxModelCalls: 4 });
  const interactiveCoordinator = new ModelCallCoordinator(interactiveGate, 16_384, 'react-turn', scheduler, {
    providerKind: 'openai-compatible',
    model: 'phase2-model',
    tokenCalibrationStore: calibrationStore,
  });
  const prepared = interactiveCoordinator.prepare({
    callKind: 'chat',
    prompt: 'legacy-combined',
    serializedBudgetText,
    requestEnvelopeVersion: 'context-envelope-v1',
  });
  assert.equal(prepared.ready, true);
  assert.equal(interactiveGate.modelCalls, 1, 'Provider 边界前必须 markSent');
  assert.equal(calibrationKey.requestEnvelopeVersion, 'context-envelope-v1');

  const overflowGate = new ModelCallBudgetGate({ maxModelCalls: 2 });
  const overflowCoordinator = new ModelCallCoordinator(overflowGate, 16_384);
  const rejected = overflowCoordinator.prepare({ callKind: 'direct', prompt: '甲'.repeat(30_000) });
  assert.equal(rejected.ready, false);
  assert.equal(rejected.reason, 'context-budget');
  assert.equal(overflowGate.modelCalls, 0, '未跨 Provider 边界的 Prompt veto 不得消费票据');

  const maintenance = new MaintenanceModelCallCoordinator({ maxConcurrent: 1, maxModelCallsPerJob: 1, maxWallTimeMs: 5_000 });
  const interactiveCallsBeforeFailure = interactiveGate.modelCalls;
  await assert.rejects(maintenance.run({
    jobId: 'phase2-maintenance-failure',
    sessionId: 'phase2-session-failure',
    callKind: 'memory-compress',
    prompt: '压缩后台记忆',
    contextWindowTokens: 16_384,
    providerKind: 'openai-compatible',
    model: 'phase2-model',
    execute: async ({ call }) => {
      assert.equal(call.ticket.budgetKind, 'maintenance-job');
      throw new Error('fixture maintenance failure');
    },
  }), /fixture maintenance failure/u);
  assert.equal(interactiveGate.modelCalls, interactiveCallsBeforeFailure, '后台失败不得影响交互式 ReAct 票据');
  assert.equal(maintenance.getStats().sent, 1);
  assert.equal(maintenance.getStats().failed, 1);

  let releaseFirst;
  let executions = 0;
  const first = maintenance.run({
    jobId: 'phase2-maintenance-first',
    callKind: 'memory-compress',
    prompt: 'first',
    contextWindowTokens: 16_384,
    model: 'phase2-model',
    execute: async () => {
      executions += 1;
      return new Promise((resolve) => { releaseFirst = resolve; });
    },
  });
  await nextTurn();
  const second = maintenance.run({
    jobId: 'phase2-maintenance-second',
    callKind: 'memory-compress',
    prompt: 'second',
    contextWindowTokens: 16_384,
    model: 'phase2-model',
    execute: async () => {
      executions += 1;
      return 'second';
    },
  });
  await nextTurn();
  assert.equal(executions, 1, '维护队列必须遵守独立并发上限');
  releaseFirst('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');

  const cancellation = maintenance.run({
    jobId: 'phase2-maintenance-cancel',
    sessionId: 'phase2-session-cancel',
    callKind: 'memory-compress',
    prompt: 'cancel',
    contextWindowTokens: 16_384,
    model: 'phase2-model',
    execute: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  await nextTurn();
  maintenance.cancelSession('phase2-session-cancel');
  await assert.rejects(cancellation, (error) => error?.name === 'AbortError');
  assert.ok(maintenance.getStats().cancelled >= 1);

  const ollamaRequests = [];
  server = http.createServer(async (request, response) => {
    const body = await readRequestJson(request);
    ollamaRequests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ response: 'ok' }));
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await generateOllamaText({
    endpoint: `http://127.0.0.1:${address.port}`,
    model: 'phase2-ollama',
    prompt: 'hello',
    contextWindowTokens: 32_768,
  });
  assert.equal(ollamaRequests[0].options.num_ctx, 32_768, 'Ollama num_ctx 必须采用已解析的有效窗口');

  verifySourceWiring();
  console.log('Context runtime Phase 2 verification passed');
} finally {
  if (server?.listening) await closeServer(server);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function verifySourceWiring() {
  const main = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const compressor = readFileSync(path.join(rootDir, 'electron/knowledge/qaMemoryCompressor.ts'), 'utf8');
  const coordinator = readFileSync(path.join(rootDir, 'electron/knowledge/modelCallCoordinator.ts'), 'utf8');
  assert.match(main, /await resolveAssistantContextWindow\(selectedProfile\.config, model\)/u);
  assert.match(main, /callKind: 'query-rewrite'/u);
  assert.match(main, /callKind: 'follow-up-suggest'/u);
  assert.match(main, /orchestrator\.cancelSession\(sessionId\);[\s\S]*?repository\.deleteSession\(sessionId\)/u);
  assert.match(compressor, /maintenanceCoordinator\.run\(\{[\s\S]*?callKind: 'memory-compress'/u);
  assert.match(compressor, /execute: \(\{ call, signal \}\) => generateAiJson/u);
  assert.match(coordinator, /this\.gate\.markSent\(ticket\);[\s\S]*?return \{ ready: true/u);
}

function bundle(relativePath, outfile) {
  return build({ entryPoints: [path.join(rootDir, relativePath)], outfile, bundle: true, platform: 'node', format: 'cjs' });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(target) {
  return new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertTemporaryPath(target) {
  const stagingBase = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(stagingBase)) throw new Error(`临时目录越界：${target}`);
}
