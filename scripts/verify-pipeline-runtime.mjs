import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const rootDir = process.cwd();
const runtimeDirectory = path.resolve(
  process.env.MENGHAN_PIPELINE_RUNTIME_DIR || path.join(rootDir, 'build', 'pipeline-runtime'),
);
const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const workerExecutable = path.join(runtimeDirectory, 'python-worker.exe');
const manifestPath = path.join(runtimeDirectory, 'runtime-manifest.json');
const verificationDirectory = mkdtempSync(path.join(os.tmpdir(), 'menghan-pipeline-runtime-'));

async function main() {
  try {
  assert.equal(packageJson.scripts['build:pipeline-runtime'], 'node scripts/build-pipeline-runtime.mjs');
  assert.match(packageJson.scripts.build, /build:pipeline-runtime/);
  assert.ok(packageJson.build.extraResources.some((resource) => resource.from === 'build/pipeline-runtime' && resource.to === 'pipeline-runtime'));
  assert.equal(existsSync(workerExecutable), true, '发布 Worker 可执行文件缺失');
  assert.equal(existsSync(manifestPath), true, '发布 Worker 清单缺失');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.worker.protocolVersion, 1);
  assert.ok(manifest.worker.capabilities.includes('runStage:chunks-v2'));
  assert.equal(manifest.worker.capabilities.includes('runStage:parse'), false);
  assert.equal(Object.hasOwn(manifest.worker, 'doclingVersion'), false);
  assert.equal(typeof manifest.worker.jiebaVersion, 'string');

  const blocksPath = path.join(verificationDirectory, 'blocks.jsonl');
  const treeDirectory = path.join(verificationDirectory, 'tree');
  const chunksDirectory = path.join(verificationDirectory, 'chunks');
  const sourcePath = path.join(verificationDirectory, '真实长文档.md');
  const sourceText = `# 阶段七真实运行验证\n\n${'该段用于验证可移植 Worker 在没有项目 Python 环境时仍可完成章节化父子切块，并且原始资料保持只读。\n\n'.repeat(160)}`;
  writeFileSync(sourcePath, sourceText, 'utf8');
  const sourceHash = hash(sourceText);
  writeFileSync(blocksPath, [
    { blockId: 'b-1', order: 1, kind: 'heading', text: '阶段七真实运行验证', source: { page: 1 } },
    { blockId: 'b-2', order: 2, kind: 'paragraph', text: sourceText.slice(0, 4_000), source: { page: 1 } },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  mkdirSync(treeDirectory, { recursive: true });
  const sectionPath = [{ nodeId: 'h-1', text: '阶段七真实运行验证' }];
  writeFileSync(path.join(treeDirectory, 'structure.jsonl'), [
    { nodeId: 'n-root', parentId: null, type: 'DOCUMENT_ROOT', sectionPath: [], sourceRefs: [] },
    { nodeId: 'h-1', parentId: 'n-root', type: 'HEADING', sectionPath, sourceRefs: [{ blockId: 'b-1' }] },
    { nodeId: 'body-1', parentId: 'h-1', type: 'BODY', sectionPath, sourceRefs: [{ blockId: 'b-2' }] },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');

  const worker = new WorkerProtocol(workerExecutable, runtimeDirectory);
  await worker.start();
  const hello = await worker.request('hello', { protocolVersion: 1 });
  assert.equal(hello.protocolVersion, 1);
  assert.ok(hello.capabilities.includes('runStage:chunks-v2'));
  assert.equal(hello.capabilities.includes('runStage:parse'), false);
  assert.equal(Object.hasOwn(hello, 'doclingVersion'), false);
  const tokenized = await worker.request('tokenizeSearch', {
    query: '投标保证金应按规定提交',
    dictionaryTerms: ['投标保证金'],
    stopwords: ['应', '按'],
  });
  assert.ok(tokenized.tokens.includes('投标保证金'));
  const chunks = await worker.request('runStage', {
    jobId: 'portable-runtime-chunks',
    stage: 'chunks',
    inputPath: treeDirectory,
    outputDir: chunksDirectory,
    options: {
      stageKey: 'portable-runtime-check',
      documentId: 'portable-runtime-doc',
      contentHash: sourceHash,
      chunkingV2: true,
      sourceBlocksPath: blocksPath,
      llmAvailable: false,
      config: recommendedConfig(),
    },
  }, 60_000);
  assert.equal(chunks.ok, true);
  const parents = jsonLines(path.join(chunksDirectory, 'parents.jsonl'));
  const children = jsonLines(path.join(chunksDirectory, 'children.jsonl'));
  assert.ok(parents.length >= 1);
  assert.ok(children.length >= 1);
  assert.ok(
    children.every((child) => child.parentChunkId && child.sectionContext && child.text.includes('章节：')),
    `Child 缺少章节上下文：${JSON.stringify(children.map((child) => ({ parentChunkId: child.parentChunkId, sectionContext: child.sectionContext, text: child.text.slice(0, 80) })))}`,
  );
  assert.equal(readFileSync(sourcePath, 'utf8'), sourceText, 'Worker 不得修改原始 Markdown');
  await worker.shutdown();

  console.log('verify-pipeline-runtime: embedded CPython Worker handshake, Parent/Child chunks-v2, resource packaging contract, and original-file preservation passed');
  } finally {
    rmSync(verificationDirectory, { recursive: true, force: true });
  }
}

class WorkerProtocol {
  constructor(executable, cwd) {
    this.executable = executable;
    this.cwd = cwd;
    this.child = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(this.executable, ['-E', '-m', 'pipeline_worker'], {
      cwd: this.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '' },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    const messages = readline.createInterface({ input: this.child.stdout });
    messages.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (value) => { this.stderr = `${this.stderr ?? ''}${value}`; });
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
      this.child.once('exit', (code) => reject(new Error(`发布 Worker 在握手前退出：${code ?? '未知'} ${this.stderr ?? ''}`)));
    });
  }

  request(method, params, timeout = 15_000) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('发布 Worker 未运行。'));
    const id = `runtime-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`发布 Worker 请求超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async shutdown() {
    try {
      await this.request('shutdown', {}, 10_000);
    } finally {
      this.child?.kill();
      this.child = null;
    }
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message.id || message.type === 'progress') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false) pending.reject(new Error(`${message.code ?? 'WORKER_FAILED'}: ${message.message ?? ''}`));
    else pending.resolve(message);
  }
}

function recommendedConfig() {
  return {
    schemaVersion: 2, mode: 'recommended', parentStrategies: ['STRUCTURE', 'RECURSIVE'], childStrategies: [],
    parentMinChars: 1200, parentTargetChars: 2400, parentMaxChars: 3500, parentOverlapChars: 200,
    childRecursiveMaxChars: 700, childRecursiveOverlapChars: 100,
    semanticMaxChars: 700, semanticMinChars: 240, semanticSimilarityThreshold: 0.18,
    llmEnabled: false, llmMaxChars: 3500, llmTimeoutMs: 45000, llmMaxOutputTokens: 2000, llmPromptVersion: 'chunk-boundary-v1', recommendLlmWhenLowQuality: true,
    pageMinMetadataCoverage: 0.8, regexPattern: '', regexFlags: [], regexBoundary: 'before', regexKeepDelimiter: true,
    childFixedTargetChars: 700, childFixedMinChars: 160, childFixedMaxChars: 900, childFixedOverlapChars: 100,
  };
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function jsonLines(filePath) {
  return readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

await main();
