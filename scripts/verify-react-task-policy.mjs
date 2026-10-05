import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// RA-1 只验证终态策略注入；不引入选择编辑入口、Provider 或 Electron 运行时。
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-react-task-policy');
fs.rmSync(outDir, { recursive: true, force: true });

try {
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'reactAgent', 'reactEngine.ts')],
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });

  const { runReActLoop, DEFAULT_REACT_TERMINAL_POLICY } = await import(pathToFileURL(path.join(outDir, 'reactEngine.js')).href);
  let checks = 0;
  const equal = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks += 1;
  };
  const ok = (condition, label) => {
    assert.ok(condition, label);
    checks += 1;
  };

  const dummyConfig = { kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'test', model: 'test' };
  const makeRegistry = () => {
    const tool = {
      name: 'lookup',
      description: '测试检索工具。',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      execute: async (args) => ({ ok: true, observation: `<evidence>${args.q}</evidence>`, message: `已检索 ${args.q}` }),
    };
    return {
      schemas: () => [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
      get: (name) => name === tool.name ? tool : undefined,
      validate: (call) => call.name === tool.name && typeof call.arguments.q === 'string' ? undefined : '工具调用无效。',
    };
  };
  const makeTransport = (responses) => {
    const calls = [];
    return {
      calls,
      transport: {
        capability: 'native-tools',
        chat: async (_config, request) => {
          calls.push({
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              toolCalls: message.toolCalls?.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
            })),
            tools: request.tools.map((tool) => tool.name),
          });
          const response = responses.shift();
          if (!response) throw new Error('脚本化响应耗尽');
          return response;
        },
      },
    };
  };
  const run = async ({ responses, terminalPolicy, budget, onModelCall, onBeforeFinalAnswer, signal = new AbortController().signal, onRound } = {}) => {
    const scripted = makeTransport(responses ?? [{ content: '默认终答', toolCalls: [] }]);
    const result = await runReActLoop({
      systemPrompt: '系统提示',
      history: [],
      question: '测试问题',
      model: 'test',
      config: dummyConfig,
      transport: scripted.transport,
      registry: makeRegistry(),
      toolContext: {},
      signal,
      ...(terminalPolicy ? { terminalPolicy } : {}),
      ...(budget ? { budget } : {}),
      ...(onModelCall ? { onModelCall } : {}),
      ...(onBeforeFinalAnswer ? { onBeforeFinalAnswer } : {}),
      ...(onRound ? { onRound } : {}),
    });
    return { result, calls: scripted.calls };
  };

  // 不传策略与显式传入默认策略必须生成同一条知识库链路。
  const defaultResponses = () => [
    { content: '', toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { q: '默认' } }] },
    { content: '<final_answer>默认答案</final_answer>', toolCalls: [] },
  ];
  const implicitDefault = await run({ responses: defaultResponses() });
  const explicitDefault = await run({ responses: defaultResponses(), terminalPolicy: DEFAULT_REACT_TERMINAL_POLICY });
  equal(implicitDefault.result, explicitDefault.result, '未传策略与显式默认策略的结果一致');
  equal(implicitDefault.calls, explicitDefault.calls, '未传策略与显式默认策略的 Provider 输入一致');
  equal(implicitDefault.result.finalAnswer, '默认答案', '默认策略仍提取 final_answer 正文');

  const emptyRetry = await run({
    responses: [
      { content: '', toolCalls: [] },
      { content: '编辑终答', toolCalls: [] },
    ],
    terminalPolicy: { emptyRetryNudge: '[编辑] 请不要留空，直接给出可写回内容。' },
  });
  equal(emptyRetry.calls[1].messages.at(-1)?.content, '[编辑] 请不要留空，直接给出可写回内容。', '空响应重试提示可由任务覆盖');

  const synthesis = await run({
    responses: [
      { content: '', toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { q: '合成' } }] },
      { content: '<final_answer>带标签的编辑结果</final_answer>', toolCalls: [] },
    ],
    budget: { maxIterations: 1 },
    terminalPolicy: {
      synthesisInstruction: '[编辑] 仅基于已读原文输出候选改写。',
      finalAnswerNormalization: 'trim',
    },
  });
  equal(synthesis.calls.at(-1)?.messages.at(-1)?.content, '[编辑] 仅基于已读原文输出候选改写。', '兜底合成提示可由任务覆盖');
  equal(synthesis.result.finalAnswer, '<final_answer>带标签的编辑结果</final_answer>', '编辑任务可选择只 trim 而不抽取知识库终答标签');

  const toolLimit = await run({
    responses: [
      {
        content: '',
        toolCalls: [
          { id: 'lookup-1', name: 'lookup', arguments: { q: '允许' } },
          { id: 'lookup-2', name: 'lookup', arguments: { q: '拒绝' } },
        ],
      },
      { content: '已有证据的终答', toolCalls: [] },
    ],
    budget: { maxToolCalls: 1 },
    terminalPolicy: { toolCallLimitReply: '[编辑] 调研次数用完，请仅依据已读原文生成。' },
  });
  const rejectedToolObservation = toolLimit.result.agentMessages.find((message) => message.role === 'tool' && message.toolCallId === 'lookup-2');
  equal(rejectedToolObservation?.content, '<tool_error>[编辑] 调研次数用完，请仅依据已读原文生成。</tool_error>', '工具上限观察可由任务覆盖');
  equal(toolLimit.calls[1].messages.at(-1)?.content, '[编辑] 调研次数用完，请仅依据已读原文生成。', '工具上限提示会进入下一轮任务上下文');

  const contextLimit = await run({
    responses: [],
    onModelCall: () => ({ ready: false, reason: 'context-budget' }),
    terminalPolicy: { contextHardLimitReply: '[编辑] 选区与证据超过模型窗口，请缩小范围后重试。' },
  });
  equal(contextLimit.result.finalAnswer, '[编辑] 选区与证据超过模型窗口，请缩小范围后重试。', '上下文硬门禁文案可由任务覆盖');
  equal(contextLimit.calls.length, 0, '上下文硬门禁不会请求 Provider');

  // 领域终答门在终态策略之外：Wiki 现有 onBeforeFinalAnswer 契约不受影响。
  let gateCalls = 0;
  const finalGate = await run({
    responses: [
      { content: '未经领域门确认的回答', toolCalls: [] },
      { content: '通过领域门的回答', toolCalls: [] },
    ],
    onBeforeFinalAnswer: () => {
      gateCalls += 1;
      return gateCalls === 1
        ? { accept: false, nudge: '[领域门] 请补充一次合法检索。' }
        : { accept: true };
    },
  });
  equal(gateCalls, 2, '终答门仍可拒绝一次并重新评估');
  equal(finalGate.calls[1].messages.at(-1)?.content, '[领域门] 请补充一次合法检索。', '终答门 nudge 未被终态策略覆盖');
  equal(finalGate.result.finalAnswer, '通过领域门的回答', '终答门放行后保留后续终答');

  const duplicateEvents = [];
  const duplicate = await run({
    responses: [
      { content: '', toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { q: '重复' } }] },
      { content: '', toolCalls: [{ id: 'lookup-2', name: 'lookup', arguments: { q: '重复' } }] },
      { content: '重复调用后仍可终答', toolCalls: [] },
    ],
    onRound: (event) => duplicateEvents.push(event),
  });
  ok(duplicateEvents.some((event) => event.state === 'rejected' && event.message === '重复动作签名命中，已拒绝重复执行。'), '重复工具调用仍由主循环拒绝');
  ok(duplicate.result.agentMessages.some((message) => message.content.includes('该检索在本会话已执行过')), '重复工具拒绝的默认观察保持不变');

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => run({ signal: cancelled.signal, terminalPolicy: { emptyRetryNudge: '[编辑] 不应发送' } }),
    (error) => error?.name === 'AbortError',
    '取消必须在终态策略生效前停止循环',
  );
  checks += 1;

  console.log(`react-task-policy 验证通过：${checks} 项断言（默认兼容、终态覆盖、领域终答门、重复工具与取消）。`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
