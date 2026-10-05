import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `context-runtime-phase3-${process.pid}-${Date.now()}`);
const outputs = {
  registry: path.join(stagingRoot, 'context-memory-registry.cjs'),
  project: path.join(stagingRoot, 'project-context-adapter.cjs'),
  qa: path.join(stagingRoot, 'qa-context-memory-adapter.cjs'),
  assembler: path.join(stagingRoot, 'qa-memory-assembler.cjs'),
  turn: path.join(stagingRoot, 'assistant-turn.cjs'),
  envelope: path.join(stagingRoot, 'context-envelope.cjs'),
  window: path.join(stagingRoot, 'effective-window.cjs'),
};

assertTemporaryPath(stagingRoot);
mkdirSync(stagingRoot, { recursive: true });
let server;
try {
  await Promise.all([
    bundle('electron/knowledge/contextMemoryRegistry.ts', outputs.registry),
    bundle('electron/knowledge/projectContextAdapter.ts', outputs.project),
    bundle('electron/knowledge/qaContextMemoryAdapter.ts', outputs.qa),
    bundle('electron/knowledge/qaMemoryAssembler.ts', outputs.assembler),
    bundle('electron/knowledge/assistantTurn.ts', outputs.turn),
    bundle('electron/knowledge/contextEnvelope.ts', outputs.envelope),
    bundle('shared/effectiveContextWindow.ts', outputs.window),
  ]);

  const { ContextMemoryRegistry } = await load(outputs.registry);
  const { ProjectContextAdapter } = await load(outputs.project);
  const { QaContextMemoryAdapter } = await load(outputs.qa);
  const { resolveQaZoneBudget } = await load(outputs.assembler);
  const {
    createAssistantProjectContext,
    createQaContextRuntimeAssembly,
    streamKnowledgeAnswer,
  } = await load(outputs.turn);
  const { createContextEnvelope } = await load(outputs.envelope);
  const { resolveAssistantModelRuntimeProfile } = await load(outputs.window);

  const repository = createRepositoryFixture();
  const qaAdapter = new QaContextMemoryAdapter(repository);
  const registry = new ContextMemoryRegistry(new ProjectContextAdapter(), [qaAdapter]);
  const profile = resolveAssistantModelRuntimeProfile({
    providerId: 'phase3-provider',
    modelId: 'phase3-model',
    discoveredPhysicalWindow: 32_768,
    discoveredSource: 'provider',
  });

  const chatBudget = resolveQaZoneBudget('chat', profile.effectiveContextTokens);
  assert.ok(chatBudget.rollingSummary <= 4_000);
  assert.ok(chatBudget.shortTerm <= 12_000);
  assert.equal(chatBudget.dynamic, 0);
  const chatMemory = await registry.load({
    route: 'chat',
    workspaceId: 'phase3-workspace',
    sessionId: 'phase3-session',
    currentQuestion: '继续说明。',
    budgets: {
      summaryTokens: chatBudget.rollingSummary,
      hotTokens: chatBudget.shortTerm,
      recallTokens: 0,
    },
    projectContext: createAssistantProjectContext('chat', ['回答末尾给出一句结论。'], 'detailed'),
  });
  assert.equal(repository.hotTurnLimits.at(-1), 6, 'QA Adapter 只能读取有上限的热历史');
  assert.equal(chatMemory.diagnostics.recalledTurns, 0, 'Phase 3 旧 Turn 召回默认关闭');
  assert.ok(chatMemory.materials.some((material) => material.zone === 'stable-policy'));
  assert.ok(chatMemory.materials.some((material) => material.zone === 'project-context'));
  const summaryMaterials = chatMemory.materials.filter((material) => material.zone === 'conversation-summary');
  const hotMaterials = chatMemory.materials.filter((material) => material.zone === 'conversation-hot');
  assert.ok(summaryMaterials.length > 1 && summaryMaterials.length < 162, '500 Turn 会话的摘要必须按 4K 预算选择并拆成独立 ContextMaterial');
  assert.equal(hotMaterials.length, 6, '每个热历史 Turn 必须是独立 ContextMaterial');
  assert.ok([...summaryMaterials, ...hotMaterials].every((material) => material.channel === 'user' && material.trust === 'untrusted-memory'));
  assert.deepEqual(hotMaterials.flatMap((material) => material.provenance?.turnSeqs ?? []), [495, 496, 497, 498, 499, 500]);
  assert.ok(summaryMaterials.reduce((sum, material) => sum + estimateTokens(material.content), 0) <= chatBudget.rollingSummary);
  assert.ok(hotMaterials.reduce((sum, material) => sum + estimateTokens(material.content), 0) <= chatBudget.shortTerm);

  const rewriteHistory = await qaAdapter.loadQueryRewriteHistory({
    route: 'knowledge-base',
    workspaceId: 'phase3-workspace',
    libraryId: 'phase3-library',
    sessionId: 'phase3-session',
    currentQuestion: '它有什么限制？',
    budgets: { summaryTokens: 4_000, hotTokens: 8_000, recallTokens: 0 },
  });
  assert.equal(repository.hotTurnLimits.at(-1), 3, 'Query Rewrite 必须通过 Adapter 获取显式三轮热历史视图');
  assert.deepEqual(rewriteHistory.map((turn) => turn.userText), ['问题 498', '问题 499', '问题 500']);

  const chatRuntime = createQaContextRuntimeAssembly({
    route: 'chat',
    callKind: 'chat',
    question: '继续说明。',
    sources: [],
    contextMemory: chatMemory,
    memoryZoneTokens: summarizeMemoryTokens(chatMemory.materials),
    skillInstructions: ['回答末尾给出一句结论。'],
    answerDepth: 'detailed',
    scope: { workspaceId: 'phase3-workspace', sessionId: 'phase3-session' },
    windowProfile: profile,
  });
  assert.equal(chatRuntime.envelope.materials.some((material) => material.zone === 'dynamic-evidence'), false, 'chat 不得构造 Dynamic Evidence');
  assert.equal(chatRuntime.projection.systemPrompt, chatRuntime.systemPrompt, 'chat enforce 必须保持 Legacy System 语义和角色结构');
  assert.equal(chatRuntime.projection.userPrompt, chatRuntime.userPrompt, 'chat enforce 必须保持 Legacy User 语义和角色结构');
  assert.deepEqual(chatRuntime.projection.included.filter((material) => material.channel === 'user').map((material) => material.zone), [
    ...Array.from({ length: summaryMaterials.length }, () => 'conversation-summary'),
    ...Array.from({ length: 6 }, () => 'conversation-hot'),
    'current-request',
  ]);

  const kbBudget = resolveQaZoneBudget('knowledge-base', profile.effectiveContextTokens);
  assert.ok(kbBudget.shortTerm <= 8_000);
  assert.ok(kbBudget.dynamic <= 20_000);
  const kbMemory = await registry.load({
    route: 'knowledge-base',
    workspaceId: 'phase3-workspace',
    libraryId: 'phase3-library',
    sessionId: 'phase3-session',
    currentQuestion: '父级证据说了什么？',
    budgets: {
      summaryTokens: kbBudget.rollingSummary,
      hotTokens: kbBudget.shortTerm,
      recallTokens: 0,
    },
    projectContext: createAssistantProjectContext('knowledge-base', [], 'auto'),
  });
  const kbRuntime = createQaContextRuntimeAssembly({
    route: 'knowledge-base',
    callKind: 'direct',
    question: '父级证据说了什么？',
    sources: [
      { title: 'A.md · 父块 2', content: '父级原文 A', sourceId: 'doc-a:parent-2' },
      { title: 'B.md · 父块 4', content: '父级原文 B', sourceId: 'doc-b:parent-4' },
    ],
    contextMemory: kbMemory,
    memoryZoneTokens: summarizeMemoryTokens(kbMemory.materials),
    skillInstructions: [],
    answerDepth: 'auto',
    scope: { workspaceId: 'phase3-workspace', libraryId: 'phase3-library', sessionId: 'phase3-session' },
    windowProfile: profile,
  });
  const evidenceMaterials = kbRuntime.envelope.materials.filter((material) => material.zone === 'dynamic-evidence');
  assert.equal(evidenceMaterials.length, 2, '每个入模父块必须是独立 Dynamic Evidence Material');
  assert.deepEqual(evidenceMaterials.map((material) => material.source.id), ['doc-a:parent-2', 'doc-b:parent-4']);
  assert.ok(evidenceMaterials.every((material) => material.channel === 'user' && material.trust === 'untrusted-evidence'));
  assert.deepEqual(kbRuntime.projectedSources.map((source) => source.content), ['父级原文 A', '父级原文 B']);
  assert.equal(kbRuntime.projection.systemPrompt, kbRuntime.systemPrompt);
  assert.equal(kbRuntime.projection.userPrompt, kbRuntime.userPrompt);
  assert.match(kbRuntime.userPrompt, /\[1\] A\.md · 父块 2\n父级原文 A/u);
  assert.ok(kbRuntime.projection.included.findIndex((material) => material.zone === 'dynamic-evidence')
    < kbRuntime.projection.included.findIndex((material) => material.zone === 'current-request'));

  const providerRequests = [];
  server = http.createServer(async (request, response) => {
    providerRequests.push(await readRequestJson(request));
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    response.end('data: {"choices":[{"delta":{"content":"阶段三回答"}}]}\n\ndata: [DONE]\n\n');
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const providerConfig = {
    kind: 'openai-compatible',
    provider: 'phase3',
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'phase3-fixture-key',
    model: 'phase3-model',
    remoteContentConsent: true,
  };
  const divergentEnvelope = createContextEnvelope({
    route: 'chat',
    callKind: 'chat',
    scope: { workspaceId: 'phase3-workspace' },
    windowProfile: profile,
    materials: [
      material('enforced-policy', 'stable-policy', 'system', 'trusted-policy', 'ENFORCED_SYSTEM'),
      material('enforced-question', 'current-request', 'user', 'untrusted-memory', 'ENFORCED_USER'),
    ],
  });
  const observations = [];
  const preparedInputs = [];
  for (const mode of ['observe', 'enforce']) {
    await streamKnowledgeAnswer({
      question: 'legacy',
      conversation: [],
      sources: [],
      prompt: 'LEGACY_SYSTEM\n\nLEGACY_USER',
      systemPrompt: 'LEGACY_SYSTEM',
      userPrompt: 'LEGACY_USER',
      model: 'phase3-model',
      signal: new AbortController().signal,
      providerConfig,
      contextWindowTokens: 32_768,
      modelCallKind: 'chat',
      assistantContextRuntimeMode: mode,
      contextEnvelope: divergentEnvelope,
      prepareModelCall: (input) => {
        preparedInputs.push(input);
        return { plan: { maxOutputTokens: 256 } };
      },
      onContextRuntimeObservation: (report) => observations.push(report),
      onDelta: () => undefined,
    });
  }
  assert.deepEqual(providerRequests[0].messages.map((message) => message.content), ['LEGACY_SYSTEM', 'LEGACY_USER'], 'observe 必须继续发送 Legacy Prompt');
  assert.deepEqual(providerRequests[1].messages.map((message) => message.content), ['ENFORCED_SYSTEM', 'ENFORCED_USER'], 'enforce 必须只发送 Projection');
  assert.deepEqual(observations.map((report) => report.sendPath), ['legacy-observe', 'projection-enforce']);
  assert.match(preparedInputs[0].serializedBudgetText, /LEGACY_USER/u);
  assert.match(preparedInputs[1].serializedBudgetText, /ENFORCED_USER/u);
  assert.equal(preparedInputs[1].requestEnvelopeVersion, 'context-envelope-v1');

  verifySourceWiring();
  console.log('Context runtime Phase 3 verification passed');
} finally {
  if (server?.listening) await closeServer(server);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function createRepositoryFixture() {
  const hotTurns = Array.from({ length: 500 }, (_, index) => ({
    turnId: `turn-${index + 1}`,
    turnSeq: index + 1,
    userText: `问题 ${index + 1}`,
    assistantText: `回答 ${index + 1}`,
    scopeLabel: index % 2 === 0 ? 'chat' : 'knowledge-base',
    status: 'complete',
    createdAt: `2026-08-26T00:${String(index).padStart(2, '0')}:00.000Z`,
    finishedAt: `2026-08-26T00:${String(index).padStart(2, '0')}:30.000Z`,
  })).reverse();
  const summaries = Array.from({ length: 162 }, (_, index) => {
    const turnFrom = 7 + index * 3;
    return summary(`batch-${index + 1}`, turnFrom, turnFrom + 2, `早期摘要 ${index + 1}：${'甲'.repeat(80)}`);
  });
  return {
    hotTurnLimits: [],
    loadHotTurns(_sessionId, limit) {
      this.hotTurnLimits.push(limit);
      return hotTurns.slice(0, limit);
    },
    listSummaries() {
      return summaries;
    },
  };
}

function summary(batchId, turnFrom, turnTo, summaryText) {
  return {
    batchId,
    turnFrom,
    turnTo,
    summaryText,
    tokens: summaryText.length,
    compressor: 'fallback',
    status: 'done',
    retryCount: 0,
    updatedAt: '2026-08-26T01:00:00.000Z',
  };
}

function summarizeMemoryTokens(materials) {
  return {
    rollingSummary: materials.filter((material) => material.zone === 'conversation-summary').reduce((sum, material) => sum + estimateTokens(material.content), 0),
    shortTerm: materials.filter((material) => material.zone === 'conversation-hot').reduce((sum, material) => sum + estimateTokens(material.content), 0),
  };
}

function estimateTokens(value) {
  let tokens = 0;
  let latinRun = 0;
  const flush = () => {
    tokens += Math.ceil(latinRun / 4);
    latinRun = 0;
  };
  for (const character of value) {
    if (/\s/u.test(character)) {
      flush();
    } else if (/^[\u3400-\u9fff]$/u.test(character)) {
      flush();
      tokens += 1;
    } else if (character.charCodeAt(0) <= 0x7f && /[A-Za-z0-9]/u.test(character)) {
      latinRun += 1;
    } else {
      flush();
      tokens += 1;
    }
  }
  flush();
  return tokens;
}

function material(id, zone, channel, trust, content) {
  return {
    id,
    zone,
    channel,
    trust,
    content,
    priority: 100,
    protected: true,
    compressStrategy: 'none',
    source: { kind: 'phase3-fixture', id, version: '1' },
    stalePolicy: 'keep',
    overflowPolicy: 'fail',
    cache: { stability: channel === 'system' ? 'stable' : 'turn', prefixEligible: channel === 'system' },
  };
}

function verifySourceWiring() {
  const main = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(rootDir, 'electron/knowledge/qaMemoryOrchestrator.ts'), 'utf8');
  const adapter = readFileSync(path.join(rootDir, 'electron/knowledge/qaContextMemoryAdapter.ts'), 'utf8');
  assert.match(main, /await qaOrchestrator\.prepareTurn\(/u);
  assert.match(main, /resolveQaContextRuntimeMode\('chat'\)/u);
  assert.match(main, /resolveQaContextRuntimeMode\('knowledge-base'\)/u);
  assert.match(main, /MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CHAT_MODE/u);
  assert.match(main, /MENGHAN_ASSISTANT_CONTEXT_RUNTIME_KNOWLEDGE_BASE_MODE/u);
  assert.match(orchestrator, /contextMemoryRegistry\.load\(/u);
  assert.match(orchestrator, /loadQueryRewriteHistory\(/u);
  assert.doesNotMatch(adapter, /better-sqlite3|SELECT\s|INSERT\s|UPDATE\s|DELETE\s/iu, 'Adapter 不得拥有 SQL 或修改数据库 Schema');
}

function bundle(relativePath, outfile) {
  return build({
    entryPoints: [path.join(rootDir, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
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

function assertTemporaryPath(target) {
  const stagingBase = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(stagingBase)) throw new Error(`临时目录越界：${target}`);
}
