const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, '.material-vector-batches-verification.cjs');
let remoteMode = 'reorder';
let ollamaMode = 'valid';
const apiKey = 'batch-test-secret';

(async () => {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/embeddings') {
        handleRemote(request, response, body);
        return;
      }
      if (request.url === '/api/embed') {
        handleOllama(response, body);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });

  try {
    await build({
      entryPoints: [path.join(rootDir, 'electron/pipeline/materialEmbeddingAdapters.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
    });
    const clients = require(bundlePath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;

    const reordered = await clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: ['first', 'second'], timeoutMs: 1_000, expectedModel: 'model-a' });
    assert.deepEqual(reordered.vectors, [[1, 0], [0, 1]]);
    assert.equal(reordered.responseModel, 'model-a');
    assert.equal(reordered.dimension, 2);
    assert.equal(reordered.usage.inputTokens, 4);
    assert.equal(reordered.requestId, 'req-batch-1');

    for (const [mode, code] of [['duplicate-index', 'EMBEDDING_RESPONSE_INVALID'], ['missing-index', 'EMBEDDING_RESPONSE_INVALID'], ['invalid-number', 'EMBEDDING_RESPONSE_INVALID'], ['dimension-mismatch', 'EMBEDDING_DIMENSION_MISMATCH'], ['model-mismatch', 'EMBEDDING_MODEL_MISMATCH']]) {
      remoteMode = mode;
      await expectCode(() => clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: ['first', 'second'], timeoutMs: 1_000, expectedModel: 'model-a' }), code);
    }

    const statusCases = [
      ['401', 'EMBEDDING_AUTH_FAILED', false],
      ['403', 'EMBEDDING_AUTH_FAILED', false],
      ['408', 'EMBEDDING_TIMEOUT', true],
      ['413', 'EMBEDDING_BATCH_TOO_LARGE', true],
      ['429', 'EMBEDDING_RATE_LIMITED', true],
      ['404', 'EMBEDDING_MODEL_UNAVAILABLE', false],
      ['500', 'EMBEDDING_NETWORK_ERROR', true],
    ];
    for (const [status, code, retryable] of statusCases) {
      remoteMode = `status-${status}`;
      await expectCode(() => clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: ['one'], timeoutMs: 1_000 }), code, (error) => {
        assert.equal(error.retryable, retryable);
        assert.equal(error.status, Number(status));
        if (status === '429') assert.equal(error.retryAfterMs, 2_000);
      });
    }

    remoteMode = 'delay';
    const cancelController = new AbortController();
    const cancelled = clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: ['one'], timeoutMs: 1_000, signal: cancelController.signal });
    setTimeout(() => cancelController.abort(), 20);
    await expectCode(() => cancelled, 'EMBEDDING_CANCELLED');
    await expectCode(() => clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: ['one'], timeoutMs: 20 }), 'EMBEDDING_TIMEOUT');

    remoteMode = 'reorder';
    const adapter = clients.createMaterialEmbeddingAdapter({ kind: 'remote', endpoint, apiKey });
    const profile = {
      schemaVersion: 1,
      sourceId: 'test-remote',
      transportKind: 'openai-compatible',
      endpointIdentity: endpoint,
      requestedModel: 'model-a',
      vectorDimension: 2,
      vectorType: 'float32',
      distanceMetric: 'cosine',
      encodingFormat: 'float',
      truncateInputs: false,
      documentInputVersion: 'material-chunk-text-v1',
      queryInputVersion: 'material-query-text-v1',
      profileHash: 'profile-test',
      state: 'LOCKED',
      lockedAt: new Date().toISOString(),
      appVersion: 'test',
    };
    const adapted = await adapter.embedBatch({ profile, texts: ['first', 'second'], timeoutMs: 1_000 });
    assert.deepEqual(adapted.vectors, [[1, 0], [0, 1]]);

    ollamaMode = 'valid';
    const ollama = await clients.embedOllamaBatch({ endpoint, model: 'model-a', texts: ['first', 'second'], timeoutMs: 1_000, expectedModel: 'model-a', truncateInputs: true });
    assert.deepEqual(ollama.vectors, [[1, 0], [0, 1]]);
    assert.equal(ollama.responseModel, 'model-a');
    assert.equal(ollama.usage.inputTokens, 4);
    ollamaMode = 'model-mismatch';
    await expectCode(() => clients.embedOllamaBatch({ endpoint, model: 'model-a', texts: ['one'], timeoutMs: 1_000, expectedModel: 'model-a' }), 'EMBEDDING_MODEL_MISMATCH');

    await expectCode(() => clients.embedRemoteBatch({ endpoint, apiKey: '', model: 'model-a', texts: ['one'] }), 'EMBEDDING_INPUT_INVALID');
    await expectCode(() => clients.embedRemoteBatch({ endpoint, apiKey, model: 'model-a', texts: [''] }), 'EMBEDDING_INPUT_INVALID');
    await expectCode(() => clients.embedRemoteBatch({ endpoint: 'http://127.0.0.1:1', apiKey, model: 'model-a', texts: ['one'], timeoutMs: 200 }), 'EMBEDDING_NETWORK_ERROR');

    console.log('verify-material-vector-batches: adapter metadata, index ordering, duplicate/missing index rejection, finite/dimension/model validation, HTTP classification, cancellation, timeout, Ollama compatibility, and unified adapter passed');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await removeTestArtifact(bundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

function handleRemote(request, response, body) {
  const payload = JSON.parse(body);
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(payload.model, 'model-a');
  if (remoteMode === 'delay') {
    setTimeout(() => sendJson(response, 200, validRemotePayload()), 200);
    return;
  }
  if (remoteMode.startsWith('status-')) {
    const status = Number(remoteMode.slice('status-'.length));
    response.statusCode = status;
    if (status === 429) response.setHeader('retry-after', '2');
    response.end('service error');
    return;
  }
  if (remoteMode === 'duplicate-index') return sendJson(response, 200, { model: 'model-a', data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] });
  if (remoteMode === 'missing-index') return sendJson(response, 200, { model: 'model-a', data: [{ index: 0, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }] });
  if (remoteMode === 'invalid-number') return sendJson(response, 200, { model: 'model-a', data: [{ index: 0, embedding: [1, null] }, { index: 1, embedding: [0, 1] }] });
  if (remoteMode === 'dimension-mismatch') return sendJson(response, 200, { model: 'model-a', data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }] });
  if (remoteMode === 'model-mismatch') return sendJson(response, 200, { model: 'model-b', data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] });
  sendJson(response, 200, validRemotePayload());
}

function handleOllama(response) {
  if (ollamaMode === 'model-mismatch') return sendJson(response, 200, { model: 'model-b', embeddings: [[1, 0]] });
  sendJson(response, 200, { model: 'model-a', embeddings: [[1, 0], [0, 1]], prompt_eval_count: 4 });
}

function validRemotePayload() {
  return { id: 'req-batch-1', model: 'model-a', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4, total_tokens: 5 } };
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

async function expectCode(operation, code, assertion) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    assertion?.(error);
    return true;
  });
}

async function removeTestArtifact(targetPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn(`verify-material-vector-batches: 临时文件清理失败：${targetPath}`);
}
