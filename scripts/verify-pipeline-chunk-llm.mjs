import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-pipeline-chunk-llm', 'chunk-llm.cjs');
await build({
  stdin: {
    contents: "export { ChunkLlmCoordinator } from './electron/pipeline/pipelineLlmCoordinator'; export { configureAiProvider } from './electron/knowledge/aiProvider';",
    resolveDir: rootDir,
    sourcefile: 'verify-pipeline-chunk-llm.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { ChunkLlmCoordinator, configureAiProvider } = await import(pathToFileURL(outFile).href);
const server = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.url, '/v1/chat/completions');
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    assert.equal(payload.response_format, undefined, 'LLM chunking must request an array, not JSON-object mode');
    assert.equal(body.includes('test-key'), false, 'API Key must not enter the model request body');
    const prompt = payload.messages?.[0]?.content ?? '';
    if (prompt.includes('slow-request')) {
      setTimeout(() => {
        if (!response.writableEnded) response.end(JSON.stringify({ choices: [{ message: { content: '["slow-request"]' } }] }));
      }, 200);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '["alpha"]' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

try {
  configureAiProvider({
    kind: 'openai-compatible',
    endpoint: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    availableModels: [{ name: 'test-model' }],
    remoteContentConsent: true,
  });
  const coordinator = new ChunkLlmCoordinator();
  assert.equal((await coordinator.getAvailability()).available, true);
  assert.equal(coordinator.fingerprint().includes('test-key'), false, 'cache fingerprints must exclude API Key');

  const responses = await coordinator.completeRequests({
    requests: [{ requestId: 'p-1-llm-0001', parentChunkId: 'p-1', documentId: 'doc-1', text: 'alpha', inputHash: 'input-hash', maxChars: 3500 }],
    timeoutMs: 1_000,
    maxOutputTokens: 80,
    signal: new AbortController().signal,
  });
  assert.deepEqual(responses, [{ requestId: 'p-1-llm-0001', inputHash: 'input-hash', output: '["alpha"]' }]);
  assert.equal(JSON.stringify(responses).includes('test-key'), false, 'continuation payload must exclude API Key');

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    coordinator.completeRequests({
      requests: [{ requestId: 'cancel', parentChunkId: 'p-1', documentId: 'doc-1', text: 'alpha', inputHash: 'input-hash', maxChars: 3500 }],
      timeoutMs: 1_000,
      maxOutputTokens: 80,
      signal: cancelled.signal,
    }),
    (error) => error?.code === 'STAGE_CANCELLED',
  );

  const inFlightCancel = new AbortController();
  const inFlight = coordinator.completeRequests({
    requests: [{ requestId: 'cancel-in-flight', parentChunkId: 'p-1', documentId: 'doc-1', text: 'slow-request', inputHash: 'input-hash', maxChars: 3500 }],
    timeoutMs: 1_000,
    maxOutputTokens: 80,
    signal: inFlightCancel.signal,
  });
  setTimeout(() => inFlightCancel.abort(), 20);
  await assert.rejects(inFlight, (error) => error?.code === 'STAGE_CANCELLED');

  await assert.rejects(
    coordinator.completeRequests({
      requests: [{ requestId: 'slow', parentChunkId: 'p-1', documentId: 'doc-1', text: 'slow-request', inputHash: 'input-hash', maxChars: 3500 }],
      timeoutMs: 10,
      maxOutputTokens: 80,
      signal: new AbortController().signal,
    }),
    (error) => error?.code === 'CHUNK_LLM_TIMEOUT',
  );

  configureAiProvider({ kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: false });
  assert.equal((await coordinator.getAvailability()).available, false);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('pipeline LLM continuation verification passed');
