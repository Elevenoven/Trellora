import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `context-runtime-baseline-${process.pid}-${Date.now()}`);
const fixturePath = path.join(rootDir, 'scripts', 'fixtures', 'context-runtime-baseline', 'role-prompts-v1.json');
const printBaseline = process.argv.includes('--print-baseline');
const outputs = {
  turn: path.join(stagingRoot, 'assistant-turn.cjs'),
  generationPolicy: path.join(stagingRoot, 'assistant-generation-policy.cjs'),
  generationTransport: path.join(stagingRoot, 'ai-generation-transport.cjs'),
  provider: path.join(stagingRoot, 'ai-provider.cjs'),
  currentNotePrompt: path.join(stagingRoot, 'current-note-prompt.cjs'),
  currentNoteAgent: path.join(stagingRoot, 'current-note-agent.cjs'),
  snapshot: path.join(stagingRoot, 'current-note-snapshot.cjs'),
  memory: path.join(stagingRoot, 'note-conversation-memory.cjs'),
  projector: path.join(stagingRoot, 'plan-aware-prompt-projector.cjs'),
  rollingSummary: path.join(stagingRoot, 'assistant-rolling-summary.cjs'),
  effectiveWindow: path.join(stagingRoot, 'effective-context-window.cjs'),
};

assertTemporaryPath(stagingRoot);
mkdirSync(stagingRoot, { recursive: true });

let server;
try {
  await Promise.all([
    bundle('electron/knowledge/assistantTurn.ts', outputs.turn),
    bundle('electron/knowledge/assistantGenerationPolicy.ts', outputs.generationPolicy),
    bundle('electron/knowledge/aiGenerationTransport.ts', outputs.generationTransport),
    bundle('electron/knowledge/aiProvider.ts', outputs.provider),
    bundle('electron/knowledge/currentNotePrompt.ts', outputs.currentNotePrompt),
    bundle('electron/knowledge/currentNoteAgentGraph.ts', outputs.currentNoteAgent),
    bundle('electron/knowledge/currentNoteSnapshot.ts', outputs.snapshot),
    bundle('electron/knowledge/noteConversationMemory.ts', outputs.memory),
    bundle('electron/knowledge/planAwarePromptProjector.ts', outputs.projector),
    bundle('electron/knowledge/assistantRollingSummary.ts', outputs.rollingSummary),
    bundle('shared/effectiveContextWindow.ts', outputs.effectiveWindow),
  ]);

  const { createAssistantChatPromptWithZones, createKnowledgeAnswerPromptWithZones, streamKnowledgeAnswer } = await load(outputs.turn);
  const { resolveAssistantAnswerTemperature } = await load(outputs.generationPolicy);
  const { resolveGenerationTemperature } = await load(outputs.generationTransport);
  const { generateAiJsonWithOptions } = await load(outputs.provider);
  const { createCurrentNotePrompt } = await load(outputs.currentNotePrompt);
  const { runCurrentNoteAgent } = await load(outputs.currentNoteAgent);
  const { createCurrentNoteSnapshot } = await load(outputs.snapshot);
  const { NoteConversationMemory } = await load(outputs.memory);
  const { PlanAwarePromptProjector } = await load(outputs.projector);
  const { emptyRollingSummaryPayload, renderRollingSummary, MAX_ROLLING_SUMMARY_CHARS } = await load(outputs.rollingSummary);
  const { resolveEffectiveContextWindow } = await load(outputs.effectiveWindow);

  const contentHash = sha256('phase-0-rolling-summary');
  const summaryHead = 'SUMMARY_HEAD::';
  const summaryTail = '::SUMMARY_TAIL';
  const summaryBody = `${summaryHead}${'摘'.repeat(MAX_ROLLING_SUMMARY_CHARS - summaryHead.length - summaryTail.length)}${summaryTail}`;
  const rollingSummary = renderRollingSummary(emptyRollingSummaryPayload(contentHash, summaryBody));
  const summaryConversation = [{ role: 'assistant', content: `会话摘要：${rollingSummary}` }];
  assert.equal(rollingSummary.length, 4_000, '当前笔记 Rolling Summary 基线必须保留 4000 字符');

  const projectorProjection = new PlanAwarePromptProjector().build({
    callKind: 'plan',
    stablePrefix: '[固定策略] Phase 0 摘要截断夹具。',
    question: '摘要末尾是什么？',
    conversation: summaryConversation,
    outputSchema: '{"type":"object"}',
  });
  const projectedConversation = projectorProjection.segments.find((segment) => segment.id === 'conversation')?.text;
  assert.ok(projectedConversation?.startsWith('助手：'));
  const projectedSummary = projectedConversation.slice('助手：'.length);
  assert.equal(projectedSummary.length, 800, 'PlanAwarePromptProjector 当前必须复现逐消息 800 字符尾部截断');
  assert.doesNotMatch(projectedSummary, /SUMMARY_HEAD/u);
  assert.match(projectedSummary, /SUMMARY_TAIL$/u);

  const memoryZonesText = '[Zone M1：滚动摘要]\n批次摘要：此前讨论了本地备份。\n\n[Zone M2：短期记忆]\n用户：请继续。\n助手：请说明目标。';
  const memoryZoneTokens = { rollingSummary: 18, shortTerm: 14 };
  const skillInstructions = ['使用项目符号列出结论。'];
  const chatAssembly = createAssistantChatPromptWithZones({
    question: '请给备份方案起三个标题。',
    memoryZonesText,
    memoryZoneTokens,
    skillInstructions,
    answerDepth: 'detailed',
  });
  const knowledgeAssembly = createKnowledgeAnswerPromptWithZones({
    question: '备份策略是什么？',
    sources: [{ title: '备份规范', content: '每晚创建本地增量备份，并保留七天。' }],
    memoryZonesText,
    memoryZoneTokens,
    skillInstructions,
    answerDepth: 'detailed',
  });

  const directMarkdown = '# 结论\n\n小笔记应直接提供全文，并保持原文边界。\n';
  const directSnapshot = createSnapshot(createCurrentNoteSnapshot, directMarkdown, 'direct.md', '直接回答基线');
  const directPrompt = createCurrentNotePrompt({
    snapshot: directSnapshot,
    question: '当前笔记的结论是什么？',
    conversation: summaryConversation,
    providerKind: 'openai-compatible',
    model: 'baseline-model',
    contextWindowTokens: 131_072,
    skillInstructions,
  });
  assert.equal(directPrompt.contextMode, 'direct-full');

  const reactMarkdown = `# 总览\n\n${'用于强制进入受控检索的稳定正文。'.repeat(140)}\n\n## 尾部验收\n\n尾部规则要求引用当前快照。`;
  const reactSnapshot = createSnapshot(createCurrentNoteSnapshot, reactMarkdown, 'react.md', 'ReAct 基线', [
    { id: 'overview', level: 1, text: '总览', line: 1 },
    { id: 'tail', level: 2, text: '尾部验收', line: 5 },
  ]);
  assert.ok(reactSnapshot.markdown.length > 1_200);
  let reactPrompt = '';
  const reactResult = await runCurrentNoteAgent({
    snapshot: reactSnapshot,
    question: '尾部验收规则是什么？',
    conversation: summaryConversation,
    providerKind: 'openai-compatible',
    model: 'baseline-model',
    contextWindowTokens: 131_072,
    skillInstructions,
    signal: new AbortController().signal,
    driver: {
      async decide({ prompt }) {
        reactPrompt = prompt;
        return { type: 'answer', answer: '基线回答。', citations: [], completeness: 'not-found' };
      },
      async synthesize() {
        throw new Error('Phase 0 基线首轮直接结束，不应进入 synthesize。');
      },
    },
    memory: new NoteConversationMemory(),
    memoryScopeKey: 'phase-0:react',
    isSnapshotCurrent: () => true,
  });
  assert.equal(reactResult.contextMode, 'react-search');
  assert.ok(reactPrompt);
  assert.match(reactPrompt, /SUMMARY_HEAD/u);
  assert.match(reactPrompt, /SUMMARY_TAIL/u);

  const requests = [];
  server = http.createServer(async (request, response) => {
    try {
      const body = await readRequestJson(request);
      requests.push({ url: request.url, body });
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end('data: {"choices":[{"delta":{"content":"基线回答"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const providerConfig = {
    kind: 'openai-compatible',
    provider: 'qwen',
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'phase-0-fixture-key',
    model: 'baseline-model',
    remoteContentConsent: true,
  };
  const creativeSkill = [{ generationStyle: 'creative' }];
  const chatTemperature = resolveAssistantAnswerTemperature({ grounded: false, skills: creativeSkill });
  const groundedTemperature = resolveAssistantAnswerTemperature({ grounded: true, skills: creativeSkill });

  await sendAnswer(streamKnowledgeAnswer, chatAssembly, chatTemperature, providerConfig, 'detailed');
  await sendAnswer(streamKnowledgeAnswer, knowledgeAssembly, groundedTemperature, providerConfig, 'detailed');
  await sendAnswer(streamKnowledgeAnswer, { prompt: directPrompt.prompt }, groundedTemperature, providerConfig, 'detailed');
  await generateAiJsonWithOptions({
    model: 'baseline-model',
    prompt: reactPrompt,
    providerConfig,
    timeoutMs: null,
    callKind: 'decide',
  });
  assert.equal(requests.length, 4);

  assertRoleRequest(requests[0].body, ['system', 'user'], chatAssembly.systemPrompt, chatAssembly.userPrompt, 0.7);
  assertRoleRequest(requests[1].body, ['system', 'user'], knowledgeAssembly.systemPrompt, knowledgeAssembly.userPrompt, 0.2);
  assertRoleRequest(requests[2].body, ['user'], undefined, directPrompt.prompt, 0.2);
  assertRoleRequest(requests[3].body, ['user'], undefined, reactPrompt, resolveGenerationTemperature(undefined));
  assert.match(chatAssembly.systemPrompt, /回答深度：详细/u);
  assert.match(knowledgeAssembly.systemPrompt, /回答深度：详细/u);
  assert.doesNotMatch(directPrompt.prompt, /回答深度：/u);
  assert.doesNotMatch(reactPrompt, /回答深度：/u);
  assert.match(chatAssembly.systemPrompt, /使用项目符号列出结论/u);
  assert.doesNotMatch(chatAssembly.systemPrompt, /此前讨论了本地备份/u);
  assert.match(chatAssembly.userPrompt, /此前讨论了本地备份/u);
  assert.doesNotMatch(knowledgeAssembly.systemPrompt, /每晚创建本地增量备份/u);
  assert.match(knowledgeAssembly.userPrompt, /每晚创建本地增量备份/u);

  const mismatch = resolveEffectiveContextWindow({
    discoveredModelWindow: 32_768,
    discoveredSource: 'provider',
    configuredModelWindow: 65_536,
  });
  assert.equal(mismatch.tokens, 32_768);
  assert.equal(mismatch.source, 'provider');
  assert.equal(mismatch.discoveredTokens, 32_768);
  assert.match(mismatch.warning ?? '', /高于已发现的物理窗口/u);

  const actualBaseline = {
    schemaVersion: 1,
    fixtureId: 'phase-0-context-runtime-v1',
    routes: {
      chat: describeRoute(requests[0], chatAssembly.prompt, 'detailed', 'projected', chatTemperature),
      knowledgeBase: describeRoute(requests[1], knowledgeAssembly.prompt, 'detailed', 'projected', groundedTemperature),
      currentNoteDirect: describeRoute(requests[2], directPrompt.prompt, 'detailed', 'not-projected', groundedTemperature),
      currentNoteReact: describeRoute(requests[3], reactPrompt, 'detailed', 'not-projected', resolveGenerationTemperature(undefined)),
    },
    rollingSummaryProjection: {
      sourceLimitChars: MAX_ROLLING_SUMMARY_CHARS,
      sourceChars: rollingSummary.length,
      sourceSha256: sha256(rollingSummary),
      projectorPerMessageChars: projectedSummary.length,
      projectedSha256: sha256(projectedSummary),
      keepsTail: projectedSummary.endsWith(summaryTail),
      keepsHead: projectedSummary.includes(summaryHead),
    },
    effectiveWindowMismatch: {
      discoveredTokens: mismatch.discoveredTokens,
      configuredCapTokens: mismatch.configuredCapTokens,
      selectedTokens: mismatch.tokens,
      source: mismatch.source,
      confidence: mismatch.confidence,
      warning: mismatch.warning,
    },
  };

  if (printBaseline) {
    process.stdout.write(`${JSON.stringify(actualBaseline, null, 2)}\n`);
  } else {
    assert.equal(existsSync(fixturePath), true, '缺少 Phase 0 Prompt 基线夹具；使用 --print-baseline 生成待审内容。');
    const expectedBaseline = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const { effectiveWindowMismatch: expectedLegacyWindow, ...expectedPromptBaseline } = expectedBaseline;
    const { effectiveWindowMismatch: actualAdaptiveWindow, ...actualPromptBaseline } = actualBaseline;
    assert.deepEqual(actualPromptBaseline, expectedPromptBaseline, 'Prompt Hash、角色结构或温度偏离 Phase 0 基线');
    assert.equal(expectedLegacyWindow.source, 'application-fixed', 'Phase 0 夹具必须保留旧 Fixed128K 证据');
    assert.equal(actualAdaptiveWindow.source, 'provider', 'Phase 2 必须采用真实 Provider 窗口');
    assert.equal(actualAdaptiveWindow.selectedTokens, 32_768);
    console.log('Context runtime Phase 0 prompt baseline and Phase 2 window delta verification passed');
  }
} finally {
  if (server?.listening) await closeServer(server);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function bundle(relativePath, outfile) {
  return build({
    entryPoints: [path.join(rootDir, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}

function createSnapshot(createCurrentNoteSnapshot, markdown, fileName, title, headings = [{ id: 'conclusion', level: 1, text: '结论', line: 1 }]) {
  return createCurrentNoteSnapshot({
    libraryPath: 'C:/Phase0/Notes',
    notePath: `C:/Phase0/Notes/${fileName}`,
    title,
    contentHash: sha256(markdown),
    markdown,
    headings,
    revision: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
  });
}

async function sendAnswer(streamKnowledgeAnswer, assembly, temperature, providerConfig, answerDepth) {
  await streamKnowledgeAnswer({
    question: 'Phase 0 基线问题',
    conversation: [],
    sources: [],
    prompt: assembly.prompt,
    ...(assembly.systemPrompt ? { systemPrompt: assembly.systemPrompt } : {}),
    ...(assembly.userPrompt ? { userPrompt: assembly.userPrompt } : {}),
    temperature,
    model: 'baseline-model',
    signal: new AbortController().signal,
    providerConfig,
    answerDepth,
    onDelta: () => undefined,
  });
}

function assertRoleRequest(body, roles, systemPrompt, userPrompt, temperature) {
  assert.deepEqual(body.messages.map((message) => message.role), roles);
  const systemMessage = body.messages.find((message) => message.role === 'system');
  const userMessage = body.messages.find((message) => message.role === 'user');
  assert.equal(systemMessage?.content, systemPrompt);
  assert.equal(userMessage?.content, userPrompt);
  assert.equal(body.temperature, temperature);
}

function describeRoute(request, legacyCombinedPrompt, answerDepth, answerDepthProjection, temperature) {
  const messages = request.body.messages;
  const systemPrompt = messages.find((message) => message.role === 'system')?.content;
  const userPrompt = messages.find((message) => message.role === 'user')?.content ?? '';
  return {
    transport: 'openai-compatible-chat-completions',
    endpointPath: request.url,
    roleStructure: messages.map((message) => message.role),
    answerDepth,
    answerDepthProjection,
    temperature,
    systemPromptChars: systemPrompt?.length ?? 0,
    systemPromptSha256: systemPrompt ? sha256(systemPrompt) : null,
    userPromptChars: userPrompt.length,
    userPromptSha256: sha256(userPrompt),
    legacyCombinedPromptChars: legacyCombinedPrompt.length,
    legacyCombinedPromptSha256: sha256(legacyCombinedPrompt),
  };
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertTemporaryPath(target) {
  const stagingBase = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(stagingBase)) throw new Error(`临时目录越界：${target}`);
}
