import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-ai-provider', 'provider.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiProvider.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
const { configureAiProvider, generateAiJson, getAiProviderStatus, resolveAiStructuredOutputCapabilities, streamAiText, testAiProviderConnection } = await import(pathToFileURL(outFile).href);
const requestFormats = [];
const server = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer test-key');
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 200_000, max_output_tokens: 16_000, supports_reasoning: true }] }));
    return;
  }
  assert.equal(request.url, '/v1/chat/completions');
  let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => {
    const payload = JSON.parse(body);
    requestFormats.push({
      model: payload.model,
      responseFormat: payload.response_format,
      enableThinking: payload.enable_thinking,
      thinking: payload.thinking,
      reasoningEffort: payload.reasoning_effort,
      reasoning: payload.reasoning,
      maxTokens: payload.max_tokens,
      maxCompletionTokens: payload.max_completion_tokens,
      temperature: payload.temperature,
      messages: payload.messages,
      stream: payload.stream,
      tools: payload.tools,
      toolChoice: payload.tool_choice,
    });
    if (payload.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"流"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"式"}}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    const outputTool = payload.tools?.[0]?.function;
    if (outputTool) {
      const argumentsJson = payload.model === 'deepseek-invalid-schema'
        ? '{"answer":123}'
        : payload.model === 'deepseek-invalid-json' ? '{"answer":' : '{"answer":"ok"}';
      const message = payload.model === 'deepseek-missing-tool'
        ? { content: '{"answer":"not-accepted-as-tool-output"}' }
        : {
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: outputTool.name, arguments: argumentsJson },
          }],
        };
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message }] }));
      return;
    }
    assert.ok(payload.response_format?.type === 'json_object' || payload.response_format?.type === 'json_schema');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// 独立的本地 Ollama 服务：验证 aiProvider 把 dataUrl 拆成纯 base64 再喂给本地 VLM（方案 §6.4 / §8 Phase 3）。
let ollamaBody = null;
const ollamaServer = http.createServer((request, response) => {
  let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => {
    ollamaBody = JSON.parse(body);
    response.setHeader('content-type', 'application/x-ndjson');
    response.write('{"response":"本地"}\n');
    response.end('{"response":"图片"}\n{"done":true}\n');
  });
});
await new Promise((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
const ollamaPort = ollamaServer.address().port;
try {
  configureAiProvider({ kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: false });
  assert.equal((await getAiProviderStatus()).available, false);
  await assert.rejects(generateAiJson({ model: 'test-model', prompt: 'hello' }), /确认远程发送范围/);
  assert.deepEqual(await generateAiJson({ model: 'test-model', prompt: 'hello', providerConfig: { kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: true } }), { answer: 'ok' });
  const tested = await testAiProviderConnection({ kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: true });
  assert.equal(tested.available, true);
  assert.equal(tested.models[0]?.contextWindowTokens, 200_000);
  assert.equal(tested.models[0]?.maxOutputTokens, 16_000);
  assert.equal(tested.models[0]?.reasoning, true);
  configureAiProvider({ kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: true });
  assert.equal((await getAiProviderStatus()).available, true);
  assert.deepEqual(await generateAiJson({ model: 'test-model', prompt: 'hello' }), { answer: 'ok' });
  const schema = { name: 'test_action', strict: true, schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } } };
  assert.deepEqual(await generateAiJson({ model: 'custom-model', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'custom', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'custom-model', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'openai-test', prompt: 'Return a JSON object.', thinkingMode: 'simple', maxOutputTokens: 2_048, jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'openai', api: 'openai-completions', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'openai-test', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'gpt-5.6', prompt: 'Return a JSON object.', thinkingMode: 'advanced', maxOutputTokens: 4_096, jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'openai', api: 'openai-completions', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'gpt-5.6', remoteContentConsent: true } }), { answer: 'ok' });
  const qwen37Max = { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.7-max-2026-06-08', remoteContentConsent: true };
  assert.deepEqual(await generateAiJson({ model: qwen37Max.model, prompt: 'Planner JSON object.', callKind: 'plan', jsonSchema: schema, providerConfig: qwen37Max }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: qwen37Max.model, prompt: 'Decision JSON object.', callKind: 'decide', jsonSchema: schema, providerConfig: qwen37Max }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'qwen3.8-max', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-max', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'qwen3.8-27b', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-27b', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'qwen3.8-27b-direct', prompt: 'Return a JSON object.', providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-27b-direct', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'qwen3.8-27b-thinking', prompt: 'Return a JSON object.', providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-27b-thinking', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'qwen3.8-27b-advanced', prompt: 'Return a JSON object.', thinkingMode: 'advanced', providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-27b-advanced', remoteContentConsent: true } }), { answer: 'ok' });
  let deepseekRawResponse;
  assert.deepEqual(await generateAiJson({ model: 'deepseek-v4-flash', prompt: 'Return a JSON object.', jsonSchema: schema, onRawResponse: (text) => { deepseekRawResponse = text; }, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-v4-flash', remoteContentConsent: true } }), { answer: 'ok' });
  assert.equal(deepseekRawResponse, '{"answer":"ok"}', '详细日志应捕获终态工具的原始参数。');
  assert.deepEqual(await generateAiJson({ model: 'deepseek-v4-simple', prompt: 'Return a JSON object.', thinkingMode: 'simple', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-v4-simple', remoteContentConsent: true } }), { answer: 'ok' });
  assert.deepEqual(await generateAiJson({ model: 'deepseek-v4-advanced', prompt: 'Return a JSON object.', thinkingMode: 'advanced', maxOutputTokens: 4_096, jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-v4-advanced', availableModels: [{ name: 'deepseek-v4-advanced', maxOutputTokens: 2_048, reasoning: true }], remoteContentConsent: true } }), { answer: 'ok' });
  await assert.rejects(
    generateAiJson({ model: 'deepseek-invalid-schema', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-invalid-schema', remoteContentConsent: true } }),
    (error) => error?.code === 'AI_STRUCTURED_OUTPUT_CONTRACT'
      && error.reason === 'schema-validation'
      && error.violations.some((violation) => violation.includes('$.answer')),
  );
  await assert.rejects(
    generateAiJson({ model: 'deepseek-missing-tool', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-missing-tool', remoteContentConsent: true } }),
    (error) => error?.code === 'AI_STRUCTURED_OUTPUT_CONTRACT' && error.reason === 'missing-tool-call',
  );
  await assert.rejects(
    generateAiJson({ model: 'deepseek-invalid-json', prompt: 'Return a JSON object.', jsonSchema: schema, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'deepseek-invalid-json', remoteContentConsent: true } }),
    SyntaxError,
  );
  await assert.rejects(
    generateAiJson({ model: 'unsupported-schema', prompt: 'Return a JSON object.', jsonSchema: { ...schema, schema: { ...schema.schema, patternProperties: {} } }, providerConfig: { kind: 'openai-compatible', provider: 'deepseek', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'unsupported-schema', remoteContentConsent: true } }),
    (error) => error?.code === 'AI_STRUCTURED_OUTPUT_CONTRACT' && error.reason === 'unsupported-schema',
  );
  const strictRequest = requestFormats.find((entry) => entry.model === 'openai-test' && entry.responseFormat?.type === 'json_schema');
  assert.equal(strictRequest?.responseFormat.json_schema.strict, true);
  assert.equal(strictRequest?.maxCompletionTokens, 2_048);
  assert.equal(strictRequest?.maxTokens, undefined);
  assert.equal(strictRequest?.reasoningEffort, undefined, '非 reasoning OpenAI 模型不得误发 reasoning_effort。');
  const openAiReasoningRequest = requestFormats.find((entry) => entry.model === 'gpt-5.6');
  assert.equal(openAiReasoningRequest?.maxCompletionTokens, 4_096);
  assert.equal(openAiReasoningRequest?.reasoningEffort, 'high');
  assert.equal(openAiReasoningRequest?.temperature, undefined, 'OpenAI reasoning 请求不应发送不兼容的 temperature。');
  const qwenStrictRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-max');
  assert.equal(qwenStrictRequest?.responseFormat.type, 'json_schema');
  assert.equal(qwenStrictRequest?.responseFormat.json_schema.strict, true);
  assert.equal(qwenStrictRequest?.enableThinking, false);
  const qwenPlannerRequest = requestFormats.find((entry) => entry.model === qwen37Max.model && entry.messages?.at(-1)?.content === 'Planner JSON object.');
  assert.equal(qwenPlannerRequest?.responseFormat.type, 'json_object', 'qwen3.7-max 的 Planner 专用调用必须回退到 json-object。');
  const qwenDecisionRequest = requestFormats.find((entry) => entry.model === qwen37Max.model && entry.messages?.at(-1)?.content === 'Decision JSON object.');
  assert.equal(qwenDecisionRequest?.responseFormat.type, 'json_schema', 'qwen3.7-max 的非 Planner 结构化调用继续使用 native JSON Schema。');
  assert.deepEqual(resolveAiStructuredOutputCapabilities(qwen37Max, qwen37Max.model, 'plan'), { transport: 'json-object', strictToolSchema: false });
  assert.deepEqual(resolveAiStructuredOutputCapabilities(qwen37Max, qwen37Max.model, 'decide'), { transport: 'native-json-schema', strictToolSchema: false });
  const qwenCompatibilityRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-27b');
  assert.equal(qwenCompatibilityRequest?.responseFormat.type, 'json_object');
  assert.equal(qwenCompatibilityRequest?.enableThinking, false);
  const qwenDirectRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-27b-direct');
  assert.equal(qwenDirectRequest?.responseFormat.type, 'json_object');
  assert.equal(qwenDirectRequest?.enableThinking, false, '模型权威 ReAct 未携带 Schema 时也必须关闭 Qwen 默认思考。');
  const qwenThinkingOnlyRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-27b-thinking');
  assert.equal(qwenThinkingOnlyRequest?.enableThinking, undefined, '显式 thinking 模型不得被强制发送关闭思考参数。');
  const qwenAdvancedRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-27b-advanced');
  assert.equal(qwenAdvancedRequest?.enableThinking, true);
  const customCompatibilityRequest = requestFormats.find((entry) => entry.model === 'custom-model');
  assert.equal(customCompatibilityRequest?.responseFormat.type, 'json_object');
  const deepseekToolRequest = requestFormats.find((entry) => entry.model === 'deepseek-v4-flash');
  assert.equal(deepseekToolRequest?.responseFormat, undefined);
  assert.equal(deepseekToolRequest?.tools?.[0]?.function?.name, 'test_action');
  assert.deepEqual(deepseekToolRequest?.tools?.[0]?.function?.parameters, schema.schema);
  assert.equal(deepseekToolRequest?.tools?.[0]?.function?.strict, undefined, '普通 DeepSeek /v1 不得误开 Beta strict。');
  assert.equal(deepseekToolRequest?.toolChoice?.function?.name, 'test_action');
  const deepseekSimpleRequest = requestFormats.find((entry) => entry.model === 'deepseek-v4-simple');
  assert.deepEqual(deepseekSimpleRequest?.thinking, { type: 'disabled' });
  assert.equal(deepseekSimpleRequest?.reasoningEffort, undefined);
  const deepseekAdvancedRequest = requestFormats.find((entry) => entry.model === 'deepseek-v4-advanced');
  assert.deepEqual(deepseekAdvancedRequest?.thinking, { type: 'enabled' });
  assert.equal(deepseekAdvancedRequest?.reasoningEffort, 'high');
  assert.equal(deepseekAdvancedRequest?.maxTokens, 2_048, '输出上限应受模型能力元数据约束。');
  assert.equal(deepseekAdvancedRequest?.maxCompletionTokens, undefined);
  assert.deepEqual(
    resolveAiStructuredOutputCapabilities({ kind: 'openai-compatible', provider: 'deepseek', endpoint: 'https://api.deepseek.com/beta' }, 'deepseek-v4-flash'),
    { transport: 'tool-call', strictToolSchema: true },
  );
  const chunks = [];
  await streamAiText({ model: 'test-model', prompt: 'hello', onDelta: (chunk) => chunks.push(chunk) });
  assert.equal(chunks.join(''), '流式');
  const qwenChunks = [];
  await streamAiText({ model: 'qwen3.8-27b', systemPrompt: '可信系统约束', prompt: '用户问题', temperature: 0.4, timeoutMs: null, onDelta: (chunk) => qwenChunks.push(chunk), providerConfig: { kind: 'openai-compatible', provider: 'qwen', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'qwen3.8-27b', remoteContentConsent: true } });
  assert.equal(qwenChunks.join(''), '流式');
  const qwenStreamRequest = requestFormats.find((entry) => entry.model === 'qwen3.8-27b' && entry.stream === true);
  assert.equal(qwenStreamRequest?.enableThinking, false);
  assert.deepEqual(qwenStreamRequest?.messages, [{ role: 'system', content: '可信系统约束' }, { role: 'user', content: '用户问题' }]);
  assert.equal(qwenStreamRequest?.temperature, 0.4);
  // aiProvider 分流（方案 §6.4 / §8 Phase 3）：Ollama 分支必须把结构化 AiTransportImage 的 dataUrl 拆成纯 base64 数组。
  const mmImage = { dataUrl: 'data:image/png;base64,QUJDRA==', mimeType: 'image/png', name: 'diagram.png' };
  const ollamaChunks = [];
  await streamAiText({ model: 'qwen-vl:latest', prompt: '看图', images: [mmImage], onDelta: (chunk) => ollamaChunks.push(chunk), providerConfig: { kind: 'ollama', endpoint: `http://127.0.0.1:${ollamaPort}`, model: 'qwen-vl:latest' } });
  assert.equal(ollamaChunks.join(''), '本地图片');
  assert.deepEqual(ollamaBody.images, ['QUJDRA=='], 'aiProvider 必须把 dataUrl 拆成纯 base64 再喂给本地 Ollama VLM。');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => ollamaServer.close((error) => error ? reject(error) : resolve()));
}
console.log('AI provider verification passed');
