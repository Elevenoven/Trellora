import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-graph-entities');
const outFile = path.join(outDir, 'graph-entities.cjs');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { DEFAULT_GRAPH_ENHANCEMENT_CONFIG, GraphEnhancementConfigError, graphEnhancementConfigHash, readLibraryGraphEnhancementConfig, saveLibraryGraphEnhancementConfig } from './electron/pipeline/graphEnhancementConfig';
      export { PipelineLlmCoordinator } from './electron/pipeline/pipelineLlmCoordinator';
      export { configureAiProvider } from './electron/knowledge/aiProvider';
    `,
    resolveDir: rootDir,
    sourcefile: 'verify-materials-graph-entities.ts',
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  DEFAULT_GRAPH_ENHANCEMENT_CONFIG,
  PipelineLlmCoordinator,
  configureAiProvider,
  graphEnhancementConfigHash,
  readLibraryGraphEnhancementConfig,
  saveLibraryGraphEnhancementConfig,
} = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 1. 库级图谱增强配置：默认关闭、保存读取、越界收敛、哈希稳定、损坏报错
// ---------------------------------------------------------------------------

const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-enhancement-lib-'));
try {
  const defaults = readLibraryGraphEnhancementConfig(libraryDir);
  assert.deepEqual(defaults, DEFAULT_GRAPH_ENHANCEMENT_CONFIG, '缺失配置必须回退到默认值');
  assert.equal(defaults.enabled, false, '图谱增强必须默认关闭');

  const migrated = saveLibraryGraphEnhancementConfig(libraryDir, {
    ...defaults,
    promptVersion: 'graph-entities-v2',
  });
  assert.equal(migrated.promptVersion, 'graph-entities-v3', '旧 v2 配置必须迁移到带强度标尺的 v3');

  const saved = saveLibraryGraphEnhancementConfig(libraryDir, {
    ...defaults,
    enabled: true,
    maxChars: 999_999,
    maxEntitiesPerChunk: 0,
    promptVersion: '不合法 版本!',
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.maxChars, 20_000, 'maxChars 必须收敛到上限');
  assert.equal(saved.maxEntitiesPerChunk, 1, 'maxEntitiesPerChunk 必须收敛到下限');
  assert.equal(saved.promptVersion, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.promptVersion, '非法 promptVersion 必须回退默认');
  const reloaded = readLibraryGraphEnhancementConfig(libraryDir);
  assert.deepEqual(reloaded, saved, '保存后必须能原样读回');

  const enabledHash = graphEnhancementConfigHash(saved);
  assert.equal(graphEnhancementConfigHash({ ...saved, llmTimeoutMs: 10_000 }), enabledHash, 'llmTimeoutMs 不参与缓存哈希');
  assert.notEqual(graphEnhancementConfigHash({ ...saved, enabled: false }), enabledHash, 'enabled 变化必须改变缓存哈希');

  const configPath = path.join(libraryDir, '.menghan-meta', 'config', 'graph-enhancement.json');
  fs.writeFileSync(configPath, '{broken json', 'utf8');
  assert.throws(() => readLibraryGraphEnhancementConfig(libraryDir), (error) => error?.code === 'GRAPH_CONFIG_INVALID');
} finally {
  fs.rmSync(libraryDir, { recursive: true, force: true });
}
console.log('[1/3] 图谱增强库级配置验证通过');

// ---------------------------------------------------------------------------
// 2. PipelineLlmCoordinator graph-entities：请求、超时、无配置错误码
// ---------------------------------------------------------------------------

const entitiesOutput = JSON.stringify({
  entities: [
    { name: '孟汉', type: 'person', description: '开发者' },
    { name: 'Electron', type: 'technology', description: '桌面框架' },
  ],
  relations: [{ source: '孟汉', target: 'Electron', kind: '使用', description: '', strength: 5 }],
});

const server = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer test-key');
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    assert.equal(body.includes('test-key'), false, 'API Key 不得进入模型请求体');
    const prompt = payload.messages?.[0]?.content ?? '';
    assert.ok(prompt.includes('实体关系抽取器'), '图谱增强必须使用实体抽取 prompt');
    assert.ok(prompt.includes('<data>'), '图谱增强 prompt 必须使用标签分隔数据段');
    assert.ok(prompt.includes('evidence'), '图谱增强 prompt 必须声明证据契约');
    assert.ok(prompt.includes('strength 评分标尺'), '图谱增强 prompt 必须提供明确的 1~10 强度标尺');
    assert.ok(prompt.includes('不要因为同一关系出现多次而提高 strength'), '模型强度不得混入统计支持次数');
    if (prompt.includes('slow-request')) {
      setTimeout(() => {
        if (!response.writableEnded) response.end(JSON.stringify({ choices: [{ message: { content: entitiesOutput } }] }));
      }, 200);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: entitiesOutput } }] }));
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
  const coordinator = new PipelineLlmCoordinator();
  assert.equal((await coordinator.getAvailability()).available, true);
  assert.equal(coordinator.fingerprint().includes('test-key'), false, '缓存指纹必须排除 API Key');
  assert.equal(coordinator.fingerprint().includes('remote-consent'), true, '缓存指纹必须包含同意状态');

  const responses = await coordinator.completeRequests({
    requests: [{ requestId: 'ent-00001', documentId: 'doc-1', chunkId: 'c-1', text: '孟汉使用 Electron。', inputHash: 'input-hash', maxChars: 6000 }],
    callKind: 'graph-entities',
    timeoutMs: 1_000,
    maxOutputTokens: 200,
    signal: new AbortController().signal,
  });
  assert.deepEqual(responses, [{ requestId: 'ent-00001', inputHash: 'input-hash', output: entitiesOutput }]);

  await assert.rejects(
    coordinator.completeRequests({
      requests: [{ requestId: 'ent-slow', documentId: 'doc-1', chunkId: 'c-1', text: 'slow-request', inputHash: 'input-hash', maxChars: 6000 }],
      callKind: 'graph-entities',
      timeoutMs: 10,
      maxOutputTokens: 200,
      signal: new AbortController().signal,
    }),
    (error) => error?.code === 'GRAPH_LLM_TIMEOUT',
  );

  configureAiProvider({ kind: 'openai-compatible', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', remoteContentConsent: false });
  await assert.rejects(
    coordinator.completeRequests({
      requests: [{ requestId: 'ent-1', documentId: 'doc-1', chunkId: 'c-1', text: '正文', inputHash: 'input-hash', maxChars: 6000 }],
      callKind: 'graph-entities',
      timeoutMs: 1_000,
      maxOutputTokens: 200,
      signal: new AbortController().signal,
    }),
    (error) => error?.code === 'GRAPH_LLM_CONFIG_REQUIRED',
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('[2/3] 图谱增强 LLM 协调器验证通过');

// ---------------------------------------------------------------------------
// 3. Python Worker NDJSON：entities prepare/finalize 两相端到端
// ---------------------------------------------------------------------------

const pythonRoot = path.join(rootDir, 'pipeline-python');
const venvPython = path.join(pythonRoot, '.venv', 'Scripts', 'python.exe');
const pythonExecutable = fs.existsSync(venvPython) ? venvPython : String(process.env.PYTHON ?? 'python');

const worker = spawn(pythonExecutable, ['-E', '-m', 'pipeline_worker'], {
  cwd: pythonRoot,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdoutBuffer = '';
const inbox = [];
const waiters = [];
worker.stdout.setEncoding('utf8');
worker.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  let index;
  while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(message)) {
        waiters.splice(i, 1)[0].resolve(message);
      }
    }
    inbox.push(message);
  }
});
worker.stderr.setEncoding('utf8');
worker.stderr.on('data', (chunk) => process.stderr.write(`[worker] ${chunk}`));

const waitFor = (match, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const existing = inbox.find(match);
  if (existing) return resolve(existing);
  const timer = setTimeout(() => reject(new Error('等待 Worker 消息超时')), timeoutMs);
  waiters.push({
    match,
    resolve: (message) => { clearTimeout(timer); resolve(message); },
  });
});
const send = (message) => worker.stdin.write(`${JSON.stringify(message)}\n`);
const runStage = async (id, params) => {
  send({ id, method: 'runStage', params });
  const result = await waitFor((message) => message.type === 'result' && message.id === id);
  if (!result.ok) throw new Error(`Worker 阶段失败：${result.error?.code} ${result.error?.message}`);
  return result;
};
const readJsonl = (filePath) => fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-entities-worker-'));
const chunksDir = path.join(workerRoot, 'chunks');
const entitiesDir = path.join(workerRoot, '09-entities');
fs.mkdirSync(chunksDir, { recursive: true });
fs.writeFileSync(path.join(chunksDir, 'children.jsonl'), [
  { chunkId: 'c-1', parentChunkId: 'p-1', text: '孟汉使用 Electron 开发桌面应用。' },
  { chunkId: 'c-2', parentChunkId: 'p-1', text: '孟汉与 Electron 团队共同维护 GraphRAG 项目。' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const stageOptions = {
  stageKey: 'ent-stage-key-1',
  documentId: 'doc-1',
  contentHash: 'a'.repeat(64),
  config: { promptVersion: 'graph-entities-v3', maxChars: 6000, maxEntitiesPerChunk: 20, maxRelationsPerChunk: 30 },
};

try {
  send({ id: 'hello-1', method: 'hello', params: { protocolVersion: 1 } });
  const hello = await waitFor((message) => message.type === 'result' && message.id === 'hello-1');
  assert.equal(hello.ok, true);
  assert.ok(hello.capabilities?.includes('runStage:entities-v1'), 'Worker capabilities 必须声明 entities');

  // v2 契约：每 3 个子块为一批，2 个子块合入同一请求。
  const prepare = await runStage('ent-prepare', {
    jobId: 'job-entities-1',
    stage: 'entities',
    inputPath: chunksDir,
    outputDir: entitiesDir,
    options: { ...stageOptions, llmPhase: 'prepare' },
  });
  assert.equal(prepare.counts.llmRequests, 1);
  const requests = readJsonl(path.join(entitiesDir, 'entities-llm-requests.jsonl'));
  assert.deepEqual(requests.map((item) => item.chunkIds), [['c-1', 'c-2']]);
  assert.ok(requests[0].text.startsWith('<chunks>'), '批次文本必须以标签分隔');
  assert.ok(requests[0].text.includes('<chunk id="c-1">'), '批次文本必须携带子块标签');
  assert.ok(fs.existsSync(path.join(entitiesDir, 'entities-llm-state.json')), 'prepare 必须写入 LLM 状态文件');

  const buildResponse = (request, entities, relations) => ({
    requestId: request.requestId,
    inputHash: request.inputHash,
    output: JSON.stringify({ entities, relations }),
  });
  const llmResponses = [
    buildResponse(requests[0], [
      { name: '孟汉', type: 'person', description: '开发者', evidence: [
        { chunkId: 'c-1', quote: '孟汉使用 Electron' },
        { chunkId: 'c-2', quote: '孟汉与 Electron 团队共同维护' },
      ] },
      { name: 'Electron', type: 'technology', description: '桌面框架', evidence: [
        { chunkId: 'c-1', quote: '使用 Electron 开发桌面应用' },
      ] },
      { name: 'GraphRAG', type: 'project', description: '图谱项目', evidence: [
        { chunkId: 'c-2', quote: '共同维护 GraphRAG 项目' },
      ] },
      // 无证据的实体必须被丢弃。
      { name: '幻觉实体', type: 'concept', description: '' },
    ], [
      { source: '孟汉', target: 'Electron', kind: '使用', description: '用于开发', strength: 3,
        evidence: [{ chunkId: 'c-1', quote: '孟汉使用 Electron 开发桌面应用' }] },
      { source: '孟汉', target: 'Electron', kind: '使用', description: '', strength: 4,
        evidence: [{ chunkId: 'c-2', quote: '孟汉与 Electron 团队共同维护 GraphRAG 项目' }] },
      { source: '孟汉', target: 'GraphRAG', kind: '维护', description: '', strength: 2,
        evidence: [{ chunkId: 'c-2', quote: '共同维护 GraphRAG 项目' }] },
      // 端点合法但证据无法召回原文的关系必须被丢弃。
      { source: '孟汉', target: 'Electron', kind: '引用', strength: 1,
        evidence: [{ chunkId: 'c-1', quote: '这句引用在原文里不存在' }] },
      // 端点未落库的关系静默拒收。
      { source: '孟汉', target: '幻觉实体', kind: '关联', strength: 1 },
    ]),
  ];

  const finalize = await runStage('ent-finalize', {
    jobId: 'job-entities-1',
    stage: 'entities',
    inputPath: chunksDir,
    outputDir: entitiesDir,
    options: { ...stageOptions, llmPhase: 'finalize', llmResponses },
  });
  assert.equal(finalize.counts.entities, 3, '应聚合出 孟汉 / electron / graphrag 三个实体');
  assert.equal(finalize.counts.relations, 2, '同名关系必须按 (source, target, kind) 合并');

  const entities = Object.fromEntries(readJsonl(path.join(entitiesDir, 'entities.jsonl')).map((row) => [row.canonicalKey, row]));
  assert.equal(entities['孟汉'].occurrences, 1, '同批声明的实体只计一次出现');
  assert.deepEqual(entities['孟汉'].chunkIds, ['c-1', 'c-2'], '出处块必须来自经验证的证据');
  assert.ok(Array.isArray(entities['孟汉'].evidence) && entities['孟汉'].evidence.length >= 2, '实体必须保留经验证的证据');
  const relations = readJsonl(path.join(entitiesDir, 'relations.jsonl'));
  const usage = relations.find((row) => row.sourceKey === '孟汉' && row.targetKey === 'electron');
  assert.equal(usage.strengthMean, 3.5, '重复关系的语义强度必须取均值，不得按出现次数累加');
  assert.equal(usage.strengthSampleCount, 2, '必须保留原始强度样本数');
  assert.equal(usage.supportChunkCount, 2, '支持块数必须独立保存');
  assert.equal('weight' in usage, false, 'entities 产物不得再把 strength 累加值伪装成 weight');
  assert.deepEqual(usage.chunkIds, ['c-1', 'c-2']);
  assert.ok(Array.isArray(usage.evidence) && usage.evidence.length >= 2, '关系必须保留经验证的证据');
  const report = JSON.parse(fs.readFileSync(path.join(entitiesDir, 'extraction-report.json'), 'utf8'));
  assert.deepEqual(report.counts, { chunks: 2, requests: 1, succeeded: 1, failed: 0, entities: 3, relations: 2, droppedEntities: 1, droppedRelations: 1 });
  assert.ok(!fs.existsSync(path.join(entitiesDir, 'entities-llm-requests.jsonl')), 'finalize 后必须清理中间请求产物');

  send({ id: 'shutdown-1', method: 'shutdown', params: {} });
  await new Promise((resolve) => {
    const timer = setTimeout(() => { worker.kill(); resolve(); }, 5_000);
    worker.on('exit', () => { clearTimeout(timer); resolve(); });
  });
} finally {
  if (worker.exitCode === null) worker.kill();
  fs.rmSync(workerRoot, { recursive: true, force: true });
}
console.log('[3/3] Python Worker entities 两相协议验证通过');
console.log('materials graph entities verification passed');
