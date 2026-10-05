import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-wk-m7-${process.pid}-${Date.now()}`);
const outfile = path.join(outDir, 'wk-m7.cjs');
mkdirSync(outDir, { recursive: true });

try {
  await build({
    stdin: {
      contents: `
        export {
          runReActLoop,
          buildConsolidationRawArchive,
          formatConsolidationTranscript,
          trimOldestAtomicHistory,
          truncateUnicodeCodePoints,
          DEFAULT_REACT_BUDGET,
        } from './electron/knowledge/reactAgent/reactEngine';
        export {
          estimateReActMessagesTokens,
          projectCurrentTurnToolResults,
          resolveCurrentTurnToolResultBudgetTokens,
        } from './electron/knowledge/reactAgent/toolResultBudget';
        export { projectReActModelRoundEvent } from './electron/knowledge/reactAgent/reactPublicModelTrace';
        export { resolveEffectiveContextWindow, resolveWorkingMemoryWindowTokens } from './shared/effectiveContextWindow';
      `,
      resolveDir: rootDir,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });

  const wk = await import(pathToFileURL(outfile).href);
  let checks = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
  };
  const msg = (role, content, extra = {}) => ({ role, content, ...extra });

  const unknown = wk.resolveEffectiveContextWindow();
  assert.equal(unknown.tokens, 200_000);
  assert.equal(unknown.runtimeProfile.runtimeProfileId, 'conservative-200k');
  assert.equal(wk.resolveWorkingMemoryWindowTokens(262_144), 200_000);
  assert.equal(wk.resolveWorkingMemoryWindowTokens(131_072), 131_072);
  assert.equal(wk.resolveCurrentTurnToolResultBudgetTokens(4_096), 8_192);
  assert.equal(wk.resolveCurrentTurnToolResultBudgetTokens(200_000), 32_768);
  checks += 6;

  const oldResult = `OLD-HEAD-${'甲'.repeat(11_980)}-OLD-TAIL`;
  const newResult = `NEW-HEAD-${'乙'.repeat(11_980)}-NEW-TAIL`;
  const toolMessages = [
    msg('system', 'SYS'),
    msg('user', '当前问题'),
    msg('assistant', '', { toolCalls: [
      { id: 'old', name: 'search', arguments: {} },
      { id: 'new', name: 'search', arguments: {} },
    ] }),
    msg('tool', oldResult, { toolCallId: 'old', toolName: 'search' }),
    msg('tool', newResult, { toolCallId: 'new', toolName: 'search' }),
  ];
  const toolProjection = wk.projectCurrentTurnToolResults(toolMessages, 1, 65_536);
  assert.equal(toolProjection.budgetTokens, Math.floor(65_536 * 0.2));
  ok(toolProjection.projectedToolResultTokens <= toolProjection.budgetTokens, '工具结果投影不得超过当前轮 20% 预算');
  assert.equal(toolProjection.messages[4].content, newResult, '最新工具结果应优先完整保留');
  ok(toolProjection.messages[3].content.startsWith('OLD-HEAD-'), '部分保留应包含约 1/4 头部');
  ok(toolProjection.messages[3].content.endsWith('-OLD-TAIL'), '部分保留应包含约 3/4 尾部');
  assert.equal(toolMessages[3].content, oldResult, 'provider 投影不得改写规范化工具消息');
  assert.equal(toolProjection.messages[2].toolCalls.length, 2, 'assistant tool-call 与结果消息结构不得拆分');
  checks += 4;

  assert.equal(Array.from(wk.truncateUnicodeCodePoints('😀'.repeat(501), 500)).length, 500);
  const archive = wk.buildConsolidationRawArchive([msg('user', `一\r\n  二${'😀'.repeat(600)}`)]);
  ok(!archive.includes('\r'), 'fallback 应统一换行');
  ok(Array.from(archive.slice(archive.indexOf('] ') + 2)).length <= 500, 'fallback 每条最多 500 Unicode code points');
  const transcript = wk.formatConsolidationTranscript([
    msg('user', '问'.repeat(2_100)),
    msg('assistant', '调'.repeat(1_100), { toolCalls: [{ id: 't', name: 'search', arguments: {} }] }),
    msg('tool', '果'.repeat(1_100), { toolCallId: 't', toolName: 'search' }),
  ]);
  ok(transcript.includes('问'.repeat(2_000)) && !transcript.includes('问'.repeat(2_001)), '普通摘要候选最多 2000 code points');
  ok(transcript.includes('调'.repeat(1_000)) && !transcript.includes('调'.repeat(1_001)), 'assistant tool-call 候选最多 1000 code points');
  ok(transcript.includes('果'.repeat(1_000)) && !transcript.includes('果'.repeat(1_001)), 'tool result 候选最多 1000 code points');
  checks += 1;

  const atomic = [
    msg('system', 'SYS'),
    msg('system', '[Memory Summary - 2 earlier messages consolidated]\n摘要'),
    msg('assistant', '调用'.repeat(300), { toolCalls: [{ id: 'a', name: 'search', arguments: {} }] }),
    msg('tool', '结果甲'.repeat(250), { toolCallId: 'a', toolName: 'search' }),
    msg('tool', '结果乙'.repeat(250), { toolCallId: 'unknown', toolName: 'search' }),
    msg('user', '最后用户问题'),
  ];
  const atomicTokens = wk.estimateReActMessagesTokens(atomic);
  const exactAtomic = atomic.map((entry) => ({ ...entry, ...(entry.toolCalls ? { toolCalls: entry.toolCalls.map((call) => ({ ...call })) } : {}) }));
  const exactTrim = wk.trimOldestAtomicHistory(exactAtomic, 5, atomicTokens, 20_000);
  assert.equal(exactTrim.removedMessages, 0, '严格等于 80% 阈值时不得裁剪');
  const overflowAtomic = atomic.map((entry) => ({ ...entry, ...(entry.toolCalls ? { toolCalls: entry.toolCalls.map((call) => ({ ...call })) } : {}) }));
  const overflowTrim = wk.trimOldestAtomicHistory(overflowAtomic, 5, atomicTokens - 1, 20_000);
  assert.equal(overflowTrim.removedMessages, 3, 'assistant tool-call 与相邻 tool results 必须整组删除');
  assert.equal(overflowAtomic[1].role, 'system');
  assert.match(overflowAtomic[1].content, /^\[Memory Summary -/u);
  assert.equal(overflowAtomic.at(-1).content, '最后用户问题');
  checks += 5;

  const emptyRegistry = { get: () => undefined, schemas: () => [], validate: () => undefined };
  const dummyConfig = { kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' };
  const baseMessages = [msg('system', 'SYS'), msg('user', '历史问题'), msg('assistant', '历史回答'), msg('user', '当前问题')];
  const exactWindow = wk.estimateReActMessagesTokens(baseMessages) * 2;
  const exactCalls = [];
  const exactResult = await wk.runReActLoop({
    systemPrompt: 'SYS', history: baseMessages.slice(1, -1), question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async (_config, request) => { exactCalls.push(request); return { content: '答案', toolCalls: [] }; } },
    registry: emptyRegistry, toolContext: {}, contextWindowTokens: exactWindow, signal: new AbortController().signal,
  });
  assert.equal(exactCalls.length, 1, '严格等于 50% 阈值时不得摘要');
  assert.equal(exactResult.maintenanceModelCalls, 0);

  const overCalls = [];
  const overModelEvents = [];
  const overResult = await wk.runReActLoop({
    systemPrompt: 'SYS', history: baseMessages.slice(1, -1), question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async (_config, request) => {
      overCalls.push(request);
      return request.messages[0].content.includes('对话历史压缩器')
        ? { content: '历史摘要', toolCalls: [] }
        : { content: '答案', toolCalls: [] };
    } },
    registry: emptyRegistry, toolContext: {}, contextWindowTokens: exactWindow - 2, signal: new AbortController().signal,
    onModelRound: (event) => overModelEvents.push(event),
  });
  assert.equal(overCalls.length, 2, '超过 50% 一个 token 即应触发摘要维护调用');
  assert.equal(overResult.modelCalls, 1, '摘要不得占用业务 modelCalls');
  assert.equal(overResult.maintenanceModelCalls, 1);
  assert.equal(overResult.consolidations, 1);
  const overStartedEvent = overModelEvents.find((event) => event.state === 'started');
  const overCompression = overStartedEvent?.inputCompression;
  ok(overCompression, '发生历史固化时，公开模型轮次必须携带压缩回执');
  assert.equal(overCompression.actions[0].kind, 'history-consolidation');
  assert.equal(overCompression.actions[0].affectedItems, 2);
  const projectedOverEvent = wk.projectReActModelRoundEvent(overStartedEvent);
  assert.deepEqual(projectedOverEvent.inputCompression, overCompression, 'renderer-safe 投影必须保留压缩动作与 token 回执');
  assert.notEqual(projectedOverEvent.inputCompression.actions, overCompression.actions, 'renderer-safe 投影不得共享可变 actions 数组');
  checks += 4;
  checks += 6;

  const timeoutCalls = [];
  const timeoutStartedAt = Date.now();
  const timeoutResult = await wk.runReActLoop({
    systemPrompt: 'SYS', history: baseMessages.slice(1, -1), question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async (_config, request) => {
      timeoutCalls.push(request);
      if (request.messages[0].content.includes('对话历史压缩器')) return await new Promise(() => undefined);
      return { content: 'fallback 后答案', toolCalls: [] };
    } },
    registry: emptyRegistry, toolContext: {}, contextWindowTokens: exactWindow - 2, signal: new AbortController().signal,
    budget: { contextConsolidationMaxAttempts: 1, contextConsolidationTimeoutMs: 10 },
  });
  ok(Date.now() - timeoutStartedAt < 500, '维护 transport 即使忽略 AbortSignal 也必须被单次超时截断');
  assert.equal(timeoutResult.maintenanceModelCalls, 1);
  assert.equal(timeoutCalls.length, 2, '超时后应使用 archive fallback 并继续业务回答');
  checks += 2;

  const usageAnchoredCalls = [];
  const usageAnchoredTraces = [];
  let usageDecision = 0;
  const usageRegistry = {
    get: () => ({ execute: async () => ({ ok: true, observation: '短结果', message: 'ok' }) }),
    schemas: () => [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
    validate: () => undefined,
  };
  const usageAnchored = await wk.runReActLoop({
    systemPrompt: 'SYS', history: [msg('user', '较早问题'), msg('assistant', '较早回答')], question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async (_config, request) => {
      usageAnchoredCalls.push(request);
      if (request.messages[0].content.includes('对话历史压缩器')) return { content: '较早对话摘要', toolCalls: [] };
      usageDecision += 1;
      return usageDecision === 1
        ? { content: '', toolCalls: [{ id: 'usage-call', name: 'search', arguments: {} }], usage: { inputTokens: 15_000 } }
        : { content: '最终答案', toolCalls: [] };
    } },
    registry: usageRegistry, toolContext: {}, contextWindowTokens: 20_000, signal: new AbortController().signal,
    onTrace: (entry) => usageAnchoredTraces.push(entry),
  });
  assert.equal(usageAnchoredCalls.length, 3, 'provider usage 锚定后超过 50% 应在下一次业务发送前触发摘要');
  assert.equal(usageAnchored.maintenanceModelCalls, 1);
  ok(usageAnchoredTraces.some((entry) => entry.action === 'consolidate' && entry.status === 'completed' && entry.detail?.tokenSource === 'provider-anchored'), '固化轨迹应记录 provider usage 优先');
  checks += 2;

  let hardVetoTransportCalls = 0;
  const hardVeto = await wk.runReActLoop({
    systemPrompt: 'SYS', history: [], question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async () => { hardVetoTransportCalls += 1; return { content: '不应发送', toolCalls: [] }; } },
    registry: emptyRegistry, toolContext: {}, signal: new AbortController().signal,
    onModelCall: () => ({ ready: true, maxPromptTokens: 1 }),
  });
  assert.equal(hardVetoTransportCalls, 0, '超过 provider maxPromptTokens 时禁止发送');
  assert.match(hardVeto.finalAnswer, /超过模型可接收上限/u);
  checks += 2;

  const rawObservation = `RAW-HEAD-${'证'.repeat(20_000)}-RAW-TAIL`;
  const providerToolMessages = [];
  const providerModelEvents = [];
  let decision = 0;
  const registry = {
    get: () => ({ execute: async () => ({ ok: true, observation: rawObservation, message: 'ok' }) }),
    schemas: () => [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
    validate: () => undefined,
  };
  const toolResult = await wk.runReActLoop({
    systemPrompt: 'SYS', history: [], question: '当前问题', model: 'm', config: dummyConfig,
    transport: { capability: 'native-tools', chat: async (_config, request) => {
      providerToolMessages.push(request.messages);
      decision += 1;
      return decision === 1
        ? { content: '', toolCalls: [{ id: 'call-1', name: 'search', arguments: {} }] }
        : { content: '最终答案', toolCalls: [] };
    } },
    registry, toolContext: {}, contextWindowTokens: 20_000, signal: new AbortController().signal,
    onModelRound: (event) => providerModelEvents.push(event),
  });
  const sentToolResult = providerToolMessages[1].find((entry) => entry.role === 'tool');
  ok(sentToolResult.content.length < rawObservation.length, '发送前应按 20% 工具预算缩短超长结果');
  assert.equal(toolResult.agentMessages.find((entry) => entry.role === 'tool').content, rawObservation, '规范化 agentMessages 必须保留原始工具结果');
  ok(!toolResult.agentMessages.some((entry) => entry.content.startsWith('[Memory Summary -')), '运行时摘要不得进入规范化持久化消息');
  const toolCompression = providerModelEvents.find((event) => event.round === 2 && event.state === 'started')?.inputCompression;
  ok(toolCompression, '工具结果发生 provider-only 缩短时，公开模型轮次必须携带压缩回执');
  assert.equal(toolCompression.actions[0].kind, 'tool-result-budget');
  assert.equal(toolCompression.actions[0].affectedItems, 1);
  checks += 2;
  checks += 1;

  console.log(`WK-M7 working-memory verification passed: ${checks} assertions.`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
