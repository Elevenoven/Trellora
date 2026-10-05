import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-ollama-client');
const outFile = path.join(outDir, 'ollama-client.cjs');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'ollamaClient.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { generateOllamaInsights, generateOllamaText, getOllamaStatus, streamOllamaText } = await import(pathToFileURL(outFile).href);
let generateBody = null;
const server = http.createServer((request, response) => {
  if (request.url === '/api/tags') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'qwen-test:latest', size: 42, context_length: 32_768 }] }));
    return;
  }
  if (request.url === '/api/generate') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      generateBody = JSON.parse(body);
      if (generateBody.stream) {
        response.setHeader('content-type', 'application/x-ndjson');
        response.write('{"response":"本地"}\n');
        response.end('{"response":"流式"}\n{"done":true}\n');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        response: typeof generateBody.format === 'object'
          ? '{"answer":"ok"}'
          : '模型前言 {"summary":"本地摘要","keyPoints":["观点一"],"suggestedTags":["#本地优先","知识管理"]} 模型后言',
      }));
    });
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}`;

try {
  const status = await getOllamaStatus(endpoint);
  assert.equal(status.available, true);
  assert.deepEqual(status.models.map((model) => model.name), ['qwen-test:latest']);
  assert.equal(status.models[0].contextWindowTokens, 32_768);

  const insight = await generateOllamaInsights({
    endpoint,
    model: 'qwen-test:latest',
    markdown: '# 原始笔记\n\n这里是用户笔记。',
    contextWindowTokens: 32_768,
  });
  assert.deepEqual(insight, {
    summary: '本地摘要',
    keyPoints: ['观点一'],
    suggestedTags: ['本地优先', '知识管理'],
  });
  assert.equal(generateBody.model, 'qwen-test:latest');
  assert.equal(generateBody.stream, false);
  assert.equal(generateBody.options.num_ctx, 32_768);
  assert.match(generateBody.prompt, /原始笔记/);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };
  assert.equal(await generateOllamaText({ endpoint, model: 'qwen-test:latest', systemPrompt: '可信系统约束', prompt: '结构化输出测试', temperature: 0.4, contextWindowTokens: 65_536, jsonSchema: schema }), '{"answer":"ok"}');
  assert.deepEqual(generateBody.format, schema, 'Ollama Structured Outputs 必须把 JSON Schema 作为 format 对象发送。');
  assert.equal(generateBody.system, '可信系统约束');
  assert.equal(generateBody.options.temperature, 0.4);
  assert.equal(generateBody.options.num_ctx, 65_536);
  const chunks = [];
  await streamOllamaText({ endpoint, model: 'qwen-test:latest', systemPrompt: '流式系统约束', prompt: '流式测试', temperature: 0.7, contextWindowTokens: 32_768, onDelta: (chunk) => chunks.push(chunk) });
  assert.equal(chunks.join(''), '本地流式');
  assert.equal(generateBody.stream, true);
  assert.equal(generateBody.options.num_ctx, 32_768);
  assert.equal(generateBody.system, '流式系统约束');
  assert.equal(generateBody.options.temperature, 0.7);
  // 本地 VLM 直传（方案 §6.4 / §8 Phase 3）：Ollama 原生 images 字段只接受纯 base64（不含 data URL 前缀）。
  await generateOllamaText({ endpoint, model: 'qwen-test:latest', prompt: '图片描述', contextWindowTokens: 32_768, images: ['QUJDRA==', 'RUZHSA=='] });
  assert.deepEqual(generateBody.images, ['QUJDRA==', 'RUZHSA=='], 'Ollama /api/generate 的 images 字段必须是纯 base64 字符串数组。');
  await streamOllamaText({ endpoint, model: 'qwen-test:latest', prompt: '流式图片', contextWindowTokens: 32_768, images: ['QUJDRA=='], onDelta: () => {} });
  assert.deepEqual(generateBody.images, ['QUJDRA=='], 'Ollama 流式请求同样透传 base64 images。');
  await assert.rejects(
    () => generateOllamaInsights({ endpoint, model: '', markdown: '内容' }),
    /请选择一个 Ollama 模型/,
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('Ollama client verification passed');
