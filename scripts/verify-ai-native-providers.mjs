import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-ai-native-providers', 'provider.cjs');
const remoteClientOutFile = path.join(rootDir, '.package-staging', 'verify-ai-native-providers', 'remote-client.cjs');
const catalogOutFile = path.join(rootDir, '.package-staging', 'verify-ai-native-providers', 'generation-catalog.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiProvider.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'remoteModelClient.ts')], outfile: remoteClientOutFile, bundle: true, platform: 'node', format: 'cjs' });
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiGenerationModelCatalog.ts')], outfile: catalogOutFile, bundle: true, platform: 'node', format: 'cjs' });
const { fetchAiProviderModels, generateAiJson, resolveAiStructuredOutputCapabilities, streamAiText } = await import(pathToFileURL(outFile).href);
const { fetchRemoteProviderModels } = await import(pathToFileURL(remoteClientOutFile).href);
const { readGenerationModelCatalogItems, readGenerationModelCatalogName, resolveGenerationModelCatalogRequest, supportsLanguageGeneration } = await import(pathToFileURL(catalogOutFile).href);

const captured = [];
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/openai/v1/models') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      return json(response, { data: [{ id: 'gpt-5.6', context_window: 200_000, max_output_tokens: 32_000, supports_reasoning: true }, { id: 'text-embedding-3-large' }, { id: 'gpt-audio-1.5' }] });
    }
    if (url.pathname === '/anthropic/v1/models') {
      assert.equal(request.headers['x-api-key'], 'test-key');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      return json(response, { data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-sonnet-4-5' }] });
    }
    if (url.pathname === '/google/v1beta/models') {
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      return json(response, { models: [{ name: 'models/gemini-3.1-pro', inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-only', supportedGenerationMethods: ['embedContent'] }] });
    }
    if (url.pathname === '/qwen/v1/models') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      return json(response, { output: { models: [{ model: 'qwen3.7-flash', name: '通义千问 3.7 Flash', capabilities: ['TG', 'Reasoning'], model_info: { context_window: 131_072, max_output_tokens: 16_384 } }, { model: 'kimi/kimi-k3', capabilities: ['TG'] }, { model: 'qwen3.7-text-embedding', capabilities: ['TR'] }, { model: 'qwen-audio-3.0-realtime-flash', capabilities: ['Realtime-Omni'] }] } });
    }

    const body = JSON.parse(await readBody(request));
    if (url.pathname === '/openai/v1/responses') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      captured.push({ api: 'openai-responses', body });
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OpenAI"}\n\n');
        response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" 流式"}\n\n');
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}}\n\n');
        return;
      }
      return json(response, { output_text: '{"answer":"openai"}', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    }
    if (url.pathname === '/openai/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer test-key');
      captured.push({ api: 'openai-completions', body });
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"Completions"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":" 多模态"}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      return json(response, { choices: [{ message: { content: '{"answer":"completions"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    }
    if (url.pathname === '/anthropic/v1/messages') {
      assert.equal(request.headers['x-api-key'], 'test-key');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      captured.push({ api: 'anthropic-messages', body });
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":2}}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" 流式"}}\n\n');
        response.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n');
        return;
      }
      return json(response, { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '{"answer":"anthropic"}' }], usage: { input_tokens: 10, output_tokens: 4 } });
    }
    if (url.pathname === '/google/v1beta/models/gemini-3.1-pro:generateContent') {
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      captured.push({ api: 'google-generate-content', body });
      return json(response, { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '{"answer":"google"}' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } });
    }
    if (url.pathname === '/google/v1beta/models/gemini-3.1-pro:streamGenerateContent') {
      assert.equal(url.searchParams.get('alt'), 'sse');
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      captured.push({ api: 'google-generate-content', body: { ...body, stream: true } });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}\n\n');
      response.end('data: {"candidates":[{"content":{"parts":[{"text":" 流式"}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":5,"totalTokenCount":13}}\n\n');
      return;
    }
    response.writeHead(404); response.end();
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(error instanceof Error ? error.stack : String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const schema = { name: 'native_result', strict: true, schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } } };
const base = `http://127.0.0.1:${port}`;
const openai = { kind: 'openai-compatible', provider: 'openai', endpoint: `${base}/openai/v1`, apiKey: 'test-key', model: 'gpt-5.6', remoteContentConsent: true };
const anthropic = { kind: 'openai-compatible', provider: 'anthropic', endpoint: `${base}/anthropic`, apiKey: 'test-key', model: 'claude-sonnet-4-6', remoteContentConsent: true };
const google = { kind: 'openai-compatible', provider: 'google', endpoint: `${base}/google/v1beta`, apiKey: 'test-key', model: 'gemini-3.1-pro', remoteContentConsent: true };
const qwen = { kind: 'openai-compatible', provider: 'qwen', endpoint: `${base}/qwen/v1`, apiKey: 'test-key', model: 'qwen3.7-flash', remoteContentConsent: true };

try {
  const openAiModels = await fetchAiProviderModels(openai);
  assert.deepEqual(openAiModels.models.map((model) => model.name), ['gpt-5.6']);
  assert.equal(openAiModels.models[0]?.name, 'gpt-5.6');
  assert.equal(openAiModels.models[0]?.contextWindowTokens, 200_000);
  assert.equal(openAiModels.models[0]?.maxOutputTokens, 32_000);
  const anthropicModels = await fetchAiProviderModels(anthropic);
  assert.deepEqual(anthropicModels.models.map((model) => model.name), ['claude-sonnet-4-6', 'claude-sonnet-4-5']);
  assert.equal(anthropicModels.models[0]?.reasoning, true);
  const googleModels = await fetchAiProviderModels(google);
  assert.deepEqual(googleModels.models.map((model) => model.name), ['gemini-3.1-pro']);
  assert.equal(googleModels.models[0]?.contextWindowTokens, 1_000_000);
  assert.equal(googleModels.models[0]?.maxOutputTokens, 65_536);
  const qwenModels = await fetchAiProviderModels(qwen);
  assert.deepEqual(qwenModels.models.map((model) => model.name), ['qwen3.7-flash', 'kimi/kimi-k3']);
  assert.equal(qwenModels.models[0]?.contextWindowTokens, 131_072);
  assert.equal(qwenModels.models[0]?.maxOutputTokens, 16_384);
  assert.equal(qwenModels.models[0]?.reasoning, true);
  assert.deepEqual((await fetchRemoteProviderModels(`${base}/anthropic`, 'test-key', 'anthropic-messages')).models, ['claude-sonnet-4-6', 'claude-sonnet-4-5']);
  assert.deepEqual((await fetchRemoteProviderModels(`${base}/google/v1beta`, 'test-key', 'google-generate-content')).models, ['gemini-3.1-pro']);

  assert.deepEqual(await generateAiJson({ model: 'gpt-5.6', systemPrompt: 'OpenAI JSON 系统约束', prompt: 'json', thinkingMode: 'advanced', maxOutputTokens: 4_096, jsonSchema: schema, providerConfig: openai }), { answer: 'openai' });
  assert.deepEqual(await generateAiJson({ model: 'claude-sonnet-4-6', systemPrompt: 'Anthropic JSON 系统约束', prompt: 'json', thinkingMode: 'advanced', maxOutputTokens: 4_096, jsonSchema: schema, providerConfig: anthropic }), { answer: 'anthropic' });
  assert.deepEqual(await generateAiJson({ model: 'claude-fable-5', prompt: 'json', thinkingMode: 'simple', maxOutputTokens: 4_096, providerConfig: { ...anthropic, model: 'claude-fable-5' } }), { answer: 'anthropic' });
  assert.deepEqual(await generateAiJson({ model: 'claude-sonnet-4-5', prompt: 'json', thinkingMode: 'advanced', maxOutputTokens: 4_096, providerConfig: { ...anthropic, model: 'claude-sonnet-4-5' } }), { answer: 'anthropic' });
  assert.deepEqual(await generateAiJson({ model: 'gemini-3.1-pro', systemPrompt: 'Gemini JSON 系统约束', prompt: 'json', thinkingMode: 'advanced', maxOutputTokens: 2_048, jsonSchema: schema, providerConfig: google }), { answer: 'google' });

  const openAiChunks = [];
  const openAiUsage = await streamAiText({ model: 'gpt-5.6', systemPrompt: 'OpenAI 系统约束', prompt: 'stream', temperature: 0.4, thinkingMode: 'simple', onDelta: (text) => openAiChunks.push(text), providerConfig: openai });
  assert.equal(openAiChunks.join(''), 'OpenAI 流式');
  assert.deepEqual(openAiUsage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  const anthropicChunks = [];
  const anthropicUsage = await streamAiText({ model: 'claude-sonnet-4-6', systemPrompt: 'Anthropic 系统约束', prompt: 'stream', temperature: 0.4, thinkingMode: 'simple', onDelta: (text) => anthropicChunks.push(text), providerConfig: anthropic });
  assert.equal(anthropicChunks.join(''), 'Claude 流式');
  assert.deepEqual(anthropicUsage, { inputTokens: 13, outputTokens: 6, totalTokens: 19, cachedInputTokens: 2 });
  const googleChunks = [];
  const googleUsage = await streamAiText({ model: 'gemini-3.1-pro', systemPrompt: 'Gemini 系统约束', prompt: 'stream', temperature: 0.4, thinkingMode: 'simple', onDelta: (text) => googleChunks.push(text), providerConfig: google });
  assert.equal(googleChunks.join(''), 'Gemini 流式');
  assert.deepEqual(googleUsage, { inputTokens: 8, outputTokens: 5, totalTokens: 13 });

  const openAiRequest = captured.find((entry) => entry.api === 'openai-responses' && !entry.body.stream);
  assert.equal(openAiRequest?.body.store, false);
  assert.equal(openAiRequest?.body.instructions, 'OpenAI JSON 系统约束');
  assert.equal(openAiRequest?.body.max_output_tokens, 4_096);
  assert.deepEqual(openAiRequest?.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(openAiRequest?.body.text.format, { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema });
  assert.equal(openAiRequest?.body.max_completion_tokens, undefined);
  const anthropicRequest = captured.find((entry) => entry.api === 'anthropic-messages' && entry.body.model === 'claude-sonnet-4-6' && !entry.body.stream);
  assert.equal(anthropicRequest?.body.max_tokens, 4_096);
  assert.equal(anthropicRequest?.body.system, 'Anthropic JSON 系统约束');
  assert.deepEqual(anthropicRequest?.body.thinking, { type: 'adaptive' });
  assert.equal(anthropicRequest?.body.output_config.effort, 'high');
  assert.deepEqual(anthropicRequest?.body.output_config.format, { type: 'json_schema', schema: schema.schema });
  const claudeFiveRequest = captured.find((entry) => entry.api === 'anthropic-messages' && entry.body.model === 'claude-fable-5');
  assert.deepEqual(claudeFiveRequest?.body.thinking, { type: 'adaptive' });
  assert.equal(claudeFiveRequest?.body.output_config.effort, 'low');
  const legacyAnthropicRequest = captured.find((entry) => entry.api === 'anthropic-messages' && entry.body.model === 'claude-sonnet-4-5');
  assert.deepEqual(legacyAnthropicRequest?.body.thinking, { type: 'enabled', budget_tokens: 3_072 });
  const googleRequest = captured.find((entry) => entry.api === 'google-generate-content' && !entry.body.stream);
  assert.equal(googleRequest?.body.generationConfig.maxOutputTokens, 2_048);
  assert.deepEqual(googleRequest?.body.systemInstruction, { parts: [{ text: 'Gemini JSON 系统约束' }] });
  assert.deepEqual(googleRequest?.body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.equal(googleRequest?.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(googleRequest?.body.generationConfig.responseJsonSchema, schema.schema);
  assert.equal(googleRequest?.body.generationConfig.temperature, undefined, 'Gemini 3 应保持官方推荐的默认温度。');

  const openAiStreamRequest = captured.find((entry) => entry.api === 'openai-responses' && entry.body.stream);
  assert.equal(openAiStreamRequest?.body.instructions, 'OpenAI 系统约束');
  assert.equal(openAiStreamRequest?.body.input, 'stream');
  assert.equal(openAiStreamRequest?.body.temperature, undefined, 'OpenAI reasoning 请求不得强行发送温度。');
  const anthropicStreamRequest = captured.find((entry) => entry.api === 'anthropic-messages' && entry.body.stream);
  assert.equal(anthropicStreamRequest?.body.system, 'Anthropic 系统约束');
  assert.deepEqual(anthropicStreamRequest?.body.messages, [{ role: 'user', content: 'stream' }]);
  assert.equal(anthropicStreamRequest?.body.temperature, undefined, 'Anthropic thinking 请求不得同时发送温度。');
  const googleStreamRequest = captured.find((entry) => entry.api === 'google-generate-content' && entry.body.stream);
  assert.deepEqual(googleStreamRequest?.body.systemInstruction, { parts: [{ text: 'Gemini 系统约束' }] });
  assert.deepEqual(googleStreamRequest?.body.contents, [{ role: 'user', parts: [{ text: 'stream' }] }]);
  assert.equal(googleStreamRequest?.body.generationConfig.temperature, undefined, 'Gemini 3 流式请求也应保持默认温度。');

  // 多模态直传（方案 §6.4 / §8 Phase 3）：四个 Transport 按各自厂商格式组装图片 content，格式互不相同。
  const mmImage = { dataUrl: 'data:image/png;base64,QUJDRA==', mimeType: 'image/png', name: 'diagram.png' };
  const openaiCompletions = { ...openai, api: 'openai-completions' };
  const mmCompletionsChunks = [];
  await streamAiText({ model: 'gpt-5.6', prompt: 'mm-completions', images: [mmImage], onDelta: (text) => mmCompletionsChunks.push(text), providerConfig: openaiCompletions });
  assert.equal(mmCompletionsChunks.join(''), 'Completions 多模态');
  const mmCompletionsRequest = captured.find((entry) => entry.api === 'openai-completions' && entry.body.stream);
  assert.deepEqual(mmCompletionsRequest?.body.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'mm-completions' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
    ],
  }]);

  await streamAiText({ model: 'gpt-5.6', prompt: 'mm-responses', images: [mmImage], onDelta: () => {}, providerConfig: openai });
  const mmResponsesRequest = captured.find((entry) => entry.api === 'openai-responses' && entry.body.stream && Array.isArray(entry.body.input));
  assert.deepEqual(mmResponsesRequest?.body.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'mm-responses' },
      { type: 'input_image', image_url: 'data:image/png;base64,QUJDRA==' },
    ],
  }], 'OpenAI Responses 的 input_image.image_url 是字符串，与 Completions 的 {url} 对象不同构。');

  await streamAiText({ model: 'claude-sonnet-4-6', prompt: 'mm-anthropic', images: [mmImage], onDelta: () => {}, providerConfig: anthropic });
  const mmAnthropicRequest = captured.find((entry) => entry.api === 'anthropic-messages' && entry.body.stream && Array.isArray(entry.body.messages?.[0]?.content));
  assert.deepEqual(mmAnthropicRequest?.body.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'mm-anthropic' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' } },
    ],
  }]);

  await streamAiText({ model: 'gemini-3.1-pro', prompt: 'mm-google', images: [mmImage], onDelta: () => {}, providerConfig: google });
  const mmGoogleRequest = captured.find((entry) => entry.api === 'google-generate-content' && entry.body.stream && (entry.body.contents?.[0]?.parts?.length ?? 0) > 1);
  assert.deepEqual(mmGoogleRequest?.body.contents, [{
    role: 'user',
    parts: [
      { text: 'mm-google' },
      { inline_data: { mime_type: 'image/png', data: 'QUJDRA==' } },
    ],
  }]);

  assert.deepEqual(resolveAiStructuredOutputCapabilities(openai, 'gpt-5.6'), { transport: 'native-json-schema', strictToolSchema: false });
  assert.deepEqual(resolveAiStructuredOutputCapabilities(anthropic, 'claude-sonnet-4-6'), { transport: 'native-json-schema', strictToolSchema: false });
  assert.deepEqual(resolveAiStructuredOutputCapabilities(google, 'gemini-3.1-pro'), { transport: 'native-json-schema', strictToolSchema: false });

  const bailianCatalogRequest = resolveGenerationModelCatalogRequest({ provider: 'qwen', api: 'openai-completions', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-key' });
  const bailianCatalogUrl = new URL(bailianCatalogRequest.url);
  assert.equal(bailianCatalogUrl.pathname, '/api/v1/models');
  assert.equal(bailianCatalogUrl.searchParams.get('capabilities'), 'TG');
  assert.equal(bailianCatalogUrl.searchParams.get('page_size'), '100');
  const bailianItems = readGenerationModelCatalogItems({ output: { models: [{ model: 'qwen3.7-max', name: '通义千问 3.7 Max', capabilities: ['TG'], model_info: { context_window: 131_072, max_output_tokens: 16_384 } }, { model: 'qwen3.7-text-embedding', capabilities: ['TR'] }] } });
  assert.equal(readGenerationModelCatalogName(bailianItems[0], 'openai-completions'), 'qwen3.7-max');
  assert.equal(supportsLanguageGeneration('qwen', 'openai-completions', bailianItems[0], 'qwen3.7-max'), true);
  assert.equal(supportsLanguageGeneration('qwen', 'openai-completions', bailianItems[1], 'qwen3.7-text-embedding'), false);
  assert.equal(supportsLanguageGeneration('custom', 'openai-completions', {}, 'vendor-rerank-v2'), false);
  assert.equal(supportsLanguageGeneration('siliconflow', 'openai-completions', { capabilities: ['Text Embedding'] }, 'vendor-vector-v2'), false);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('Native AI provider verification passed');

function json(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}
