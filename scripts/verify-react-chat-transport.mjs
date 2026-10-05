import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-react-chat-transport', 'react-chat.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'reactAgent', 'reactChatTransport.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
const { createReActChatTransport } = await import(pathToFileURL(outFile).href);

const captured = [];
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = JSON.parse(await readBody(request));
    if (url.pathname === '/openai/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      captured.push({ api: 'openai-completions', body });
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"流式"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"reasoning_content":"思考","content":"流式回答"}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      if (body.messages.some((message) => message.role === 'tool')) {
        // 第二轮：已有工具结果，模型给出最终回答。
        return json(response, { choices: [{ message: { content: '根据证据，谐波抑制指…[1]', reasoning_content: '最终显式推理' } }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
      }
      return json(response, {
        choices: [{ message: { content: '我先检索资料库。', reasoning_content: '工具显式推理', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'knowledge_search', arguments: '{"queries":["谐波抑制的原理"]}' } }] } }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      });
    }
    if (url.pathname === '/openai/v1/responses') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      captured.push({ api: 'openai-responses', body });
      return json(response, {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '需要精确检索。' }] },
          { type: 'function_call', call_id: 'call_2', name: 'grep_chunks', arguments: '{"pattern":"THD"}' },
        ],
        usage: { input_tokens: 25, output_tokens: 9, total_tokens: 34 },
      });
    }
    if (url.pathname === '/anthropic/v1/messages') {
      assert.equal(request.headers['x-api-key'], 'test-key');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      captured.push({ api: 'anthropic-messages', body });
      return json(response, {
        content: [
          { type: 'text', text: '先深读原文。' },
          { type: 'tool_use', id: 'call_3', name: 'list_knowledge_chunks', input: { document_id: 'doc-3', ordinal: 7 } },
        ],
        usage: { input_tokens: 28, output_tokens: 11 },
      });
    }
    if (url.pathname === '/google/v1beta/models/gemini-3.1-pro:generateContent') {
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      captured.push({ api: 'google-generate-content', body });
      return json(response, {
        candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '需要文档元数据。' }, { functionCall: { name: 'get_document_info', args: { document_id: 'doc-3' } } }] } }],
        usageMetadata: { promptTokenCount: 26, candidatesTokenCount: 7, totalTokenCount: 33 },
      });
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `unexpected path ${url.pathname}` } }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const endpoint = (subpath) => `http://127.0.0.1:${port}${subpath}`;

const tools = [
  { name: 'knowledge_search', description: '按含义检索资料库。', parameters: { type: 'object', properties: { queries: { type: 'array' } }, required: ['queries'] } },
  { name: 'grep_chunks', description: '字面量检索。', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
];

const image = {
  dataUrl: 'data:image/png;base64,ZmFrZQ==',
  mimeType: 'image/png',
  name: 'diagram.png',
};

/** 携带工具调用历史的多轮会话：system + 两个 user + 一次 assistant tool_calls + 一次 tool 结果。 */
const conversation = [
  { role: 'system', content: '你是资料库助手。' },
  { role: 'user', content: '什么是谐波抑制？' },
  { role: 'assistant', content: '我先检索资料库。', reasoningContent: '历史显式推理', toolCalls: [{ id: 'call_1', name: 'knowledge_search', arguments: { queries: ['谐波抑制的原理'] } }] },
  { role: 'tool', toolCallId: 'call_1', toolName: 'knowledge_search', content: '<result reference="[1]">谐波抑制…</result>' },
  { role: 'user', content: '请继续给出结论。', images: [image] },
];

// ---------- Ollama 降级 ----------
assert.equal(createReActChatTransport({ kind: 'ollama' }, 'qwen3:8b'), undefined, 'Ollama 应返回 undefined 由引擎走 JSON 仿真');

// ---------- OpenAI Completions（DeepSeek 等兼容网关） ----------
{
  const config = { kind: 'openai-compatible', provider: 'deepseek', endpoint: endpoint('/openai/v1'), apiKey: 'test-key', model: 'deepseek-chat', remoteContentConsent: true };
  const transport = createReActChatTransport(config, 'deepseek-chat');
  assert.ok(transport && transport.capability === 'native-tools', 'deepseek 应走原生工具调用');

  // 第一轮：历史中含 tool 消息，mock 直接返回最终回答（验证请求映射）。
  const finalAnswer = await transport.chat(config, { messages: conversation, tools, model: 'deepseek-chat' });
  assert.equal(finalAnswer.content, '根据证据，谐波抑制指…[1]');
  assert.equal(finalAnswer.reasoningContent, '最终显式推理');
  assert.deepEqual(finalAnswer.toolCalls, []);
  assert.equal(finalAnswer.usage?.totalTokens, 48);
  const request = captured.find((entry) => entry.api === 'openai-completions');
  assert.deepEqual(request.body.messages[0], { role: 'system', content: '你是资料库助手。' });
  const assistant = request.body.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content, '我先检索资料库。');
  assert.equal(assistant.reasoning_content, '历史显式推理');
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'knowledge_search', arguments: '{"queries":["谐波抑制的原理"]}' } }]);
  const tool = request.body.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(request.body.tools.length, 2);
  assert.equal(request.body.tools[0].type, 'function');
  assert.equal(request.body.tools[0].function.name, 'knowledge_search');
  const imageMessage = request.body.messages.at(-1);
  assert.ok(Array.isArray(imageMessage.content), 'OpenAI Completions 带图 user 消息应使用多段 content');
  assert.deepEqual(imageMessage.content.at(-1), { type: 'image_url', image_url: { url: image.dataUrl } });

  // 工具调用响应解析（去掉 tool 消息触发 mock 的 tool_calls 分支）。
  const toolCallTurn = await transport.chat(config, { messages: conversation.slice(0, 2), tools, model: 'deepseek-chat' });
  assert.equal(toolCallTurn.content, '我先检索资料库。');
  assert.equal(toolCallTurn.reasoningContent, '工具显式推理');
  assert.deepEqual(toolCallTurn.toolCalls, [{ id: 'call_1', name: 'knowledge_search', arguments: { queries: ['谐波抑制的原理'] } }]);

  const thinkingDeltas = [];
  const streamed = await transport.chat(config, {
    messages: conversation,
    tools,
    model: 'deepseek-chat',
    onDelta: () => undefined,
    onThinkingDelta: (text) => thinkingDeltas.push(text),
  });
  assert.equal(streamed.content, '流式回答');
  assert.equal(streamed.reasoningContent, '流式思考');
  assert.deepEqual(thinkingDeltas, ['流式', '思考']);
}

// Qwen 混合思考：ReAct 请求必须把用户选择映射为顶层 enable_thinking。
{
  const config = { kind: 'openai-compatible', provider: 'qwen', endpoint: endpoint('/openai/v1'), apiKey: 'test-key', model: 'qwen3.8-max', remoteContentConsent: true };
  const transport = createReActChatTransport(config, 'qwen3.8-max');
  assert.ok(transport, 'qwen 应走 OpenAI Completions 原生工具协议');
  await transport.chat(config, { messages: conversation, tools, model: 'qwen3.8-max', thinkingMode: 'advanced' });
  const request = captured.find((entry) => entry.api === 'openai-completions' && entry.body.model === 'qwen3.8-max');
  assert.equal(request?.body.enable_thinking, true, 'ReAct 高级思考必须向 Qwen 发送 enable_thinking=true');
}

// ---------- OpenAI Responses ----------
{
  const config = { kind: 'openai-compatible', provider: 'openai', endpoint: endpoint('/openai/v1'), apiKey: 'test-key', model: 'gpt-5.1', remoteContentConsent: true };
  const transport = createReActChatTransport(config, 'gpt-5.1');
  assert.ok(transport, 'openai 应走 Responses 协议');
  const result = await transport.chat(config, { messages: conversation, tools, model: 'gpt-5.1' });
  assert.equal(result.content, '需要精确检索。');
  assert.deepEqual(result.toolCalls, [{ id: 'call_2', name: 'grep_chunks', arguments: { pattern: 'THD' } }]);
  const request = captured.find((entry) => entry.api === 'openai-responses');
  assert.equal(request.body.instructions, '你是资料库助手。');
  assert.ok(request.body.input.some((item) => item.type === 'function_call' && item.call_id === 'call_1' && item.arguments.includes('谐波抑制的原理')), '历史工具调用应映射为 function_call 项');
  assert.ok(request.body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1'), '工具结果应映射为 function_call_output 项');
  assert.equal(request.body.tools[0].name, 'knowledge_search');
  const responseImage = request.body.input.flatMap((item) => item.content ?? []).find((part) => part.type === 'input_image');
  assert.deepEqual(responseImage, { type: 'input_image', image_url: image.dataUrl });
}

// ---------- Anthropic Messages ----------
{
  const config = { kind: 'openai-compatible', provider: 'anthropic', endpoint: endpoint('/anthropic'), apiKey: 'test-key', model: 'claude-sonnet-4-5', remoteContentConsent: true };
  const transport = createReActChatTransport(config, 'claude-sonnet-4-5');
  assert.ok(transport, 'anthropic 应走 Messages 协议');
  const result = await transport.chat(config, { messages: conversation, tools, model: 'claude-sonnet-4-5' });
  assert.equal(result.content, '先深读原文。');
  assert.deepEqual(result.toolCalls, [{ id: 'call_3', name: 'list_knowledge_chunks', arguments: { document_id: 'doc-3', ordinal: 7 } }]);
  const request = captured.find((entry) => entry.api === 'anthropic-messages');
  assert.equal(request.body.system, '你是资料库助手。');
  assert.equal(request.body.tools[0].name, 'knowledge_search');
  assert.ok(request.body.tools[0].input_schema, 'Anthropic 工具参数应放 input_schema');
  // 消息必须 user 开头且交替；tool_result 归属 user。
  const roles = request.body.messages.map((message) => message.role);
  assert.equal(roles[0], 'user');
  assert.ok(roles.every((role, index) => index === 0 || role !== roles[index - 1]), 'Anthropic messages 必须严格交替');
  const assistantBlocks = request.body.messages.find((message) => message.role === 'assistant').content;
  assert.ok(assistantBlocks.some((block) => block.type === 'tool_use' && block.id === 'call_1'), 'assistant 历史应含 tool_use 块');
  const userBlocks = request.body.messages.flatMap((message) => (message.role === 'user' ? message.content : []));
  assert.ok(userBlocks.some((block) => block.type === 'tool_result' && block.tool_use_id === 'call_1'), '工具结果应作为 user 消息的 tool_result 块');
  assert.ok(userBlocks.some((block) => block.type === 'image' && block.source?.media_type === 'image/png' && block.source?.data === 'ZmFrZQ=='), 'Anthropic user 消息应包含 base64 图片块');
}

// ---------- Google GenerateContent ----------
{
  const config = { kind: 'openai-compatible', provider: 'google', endpoint: endpoint('/google/v1beta'), apiKey: 'test-key', model: 'gemini-3.1-pro', remoteContentConsent: true };
  const transport = createReActChatTransport(config, 'gemini-3.1-pro');
  assert.ok(transport, 'google 应走 GenerateContent 协议');
  const result = await transport.chat(config, { messages: conversation, tools, model: 'gemini-3.1-pro' });
  assert.equal(result.content, '需要文档元数据。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'get_document_info');
  assert.deepEqual(result.toolCalls[0].arguments, { document_id: 'doc-3' });
  assert.ok(result.toolCalls[0].id, 'Gemini 无原生调用 id，应补合成 id');
  const request = captured.find((entry) => entry.api === 'google-generate-content');
  assert.equal(request.body.systemInstruction.parts[0].text, '你是资料库助手。');
  assert.equal(request.body.tools[0].functionDeclarations[0].name, 'knowledge_search');
  const modelContent = request.body.contents.find((entry) => entry.role === 'model');
  assert.ok(modelContent.parts.some((part) => part.functionCall?.name === 'knowledge_search'), 'assistant 历史应映射为 functionCall part');
  const functionResponses = request.body.contents.flatMap((entry) => entry.parts.filter((part) => part.functionResponse));
  assert.equal(functionResponses.length, 1);
  assert.equal(functionResponses[0].functionResponse.name, 'knowledge_search');
  assert.ok(request.body.contents.flatMap((entry) => entry.parts).some((part) => part.inline_data?.mime_type === 'image/png' && part.inline_data?.data === 'ZmFrZQ=='), 'Google user 消息应包含 inline_data 图片块');
  // gemini-3.x 保留官方默认温度。
  assert.ok(!request.body.generationConfig?.temperature, 'gemini-3.x 不应发送 temperature');
}

server.close();
console.log(`react-chat-transport 验证通过：${captured.length} 次调用，四个协议映射与解析全部符合契约。`);

function json(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
