import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-pipeline-p2');
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');

const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const statusHandlerStart = mainSource.indexOf("registerAppHandler('get-materials-pipeline-status'");
assert.notEqual(statusHandlerStart, -1, '资料流水线状态 IPC 不存在');
const statusHandlerEnd = mainSource.indexOf('\n});', statusHandlerStart);
assert.notEqual(statusHandlerEnd, -1, '资料流水线状态 IPC 边界无效');
const statusHandlerSource = mainSource.slice(statusHandlerStart, statusHandlerEnd + 4);
assert.doesNotMatch(statusHandlerSource, /\.recoverLibrary\(/u, '状态查询不得执行中断恢复或改写 RUNNING 阶段');
assert.match(statusHandlerSource, /\.getStatuses\(targetPath\)/u, '状态查询必须直接读取当前流水线状态');
assert.match(
  mainSource,
  /pipelineOrchestrator\.recoverLibrary\(library\.path\);\s*void pipelineOrchestrator\.enqueuePending\(library\.path\)/u,
  '应用启动时仍应先恢复上次真正中断的阶段，再自动入队',
);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { resolveParsingRoute } from './electron/pipeline/routes';
      export { prepareParseLayout, commitParseStage, isParseCacheValid, createParseTempDirectory } from './electron/pipeline/artifactStore';
      export { runDirectTextParse } from './electron/pipeline/textStage';
      export { runMineruPdfParse } from './electron/pipeline/mineruClient';
      export { createParseImageSink } from './electron/pipeline/parseImages';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  commitParseStage,
  createParseImageSink,
  createParseTempDirectory,
  isParseCacheValid,
  prepareParseLayout,
  resolveParsingRoute,
  runDirectTextParse,
  runMineruPdfParse,
} = await import(pathToFileURL(outFile).href);

assert.equal(resolveParsingRoute('.md'), 'direct');
assert.equal(resolveParsingRoute('.json'), 'direct');
assert.equal(resolveParsingRoute('.docx'), 'mammoth');
assert.equal(resolveParsingRoute('.pptx'), 'unsupported');
assert.equal(resolveParsingRoute('.doc'), 'unsupported');
assert.equal(resolveParsingRoute('.xlsx'), 'unsupported');
assert.equal(resolveParsingRoute('.epub'), 'unsupported');
assert.equal(resolveParsingRoute('.pdf'), 'mineru');

const sourcePath = path.join(documentsDir, 'large-notes.md');
const sourceText = Array.from({ length: 5_000 }, (_, index) => index % 100 === 0 ? `# 第 ${index} 节` : `正文第 ${index} 行`).join('\n');
writeFileSync(sourcePath, sourceText, 'utf8');
const document = {
  id: 'doc-direct-p2',
  name: 'large-notes.md',
  relativePath: 'documents/large-notes.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: Buffer.byteLength(sourceText),
  addedAt: new Date().toISOString(),
  contentHash: 'a'.repeat(64),
  vectorState: 'pending',
};

const layout = prepareParseLayout(libraryDir, document);
const tempDirectory = createParseTempDirectory(layout, 'job-direct-p2');
const result = await runDirectTextParse({ inputPath: sourcePath, outputDir: tempDirectory, extension: '.md', signal: new AbortController().signal });
assert.equal(result.counts.lines, 5_000);
assert.equal(result.counts.blocks, 5_000);
createParseImageSink(tempDirectory).writeManifest(tempDirectory);
await commitParseStage(layout, tempDirectory);
assert.equal(await isParseCacheValid(layout), true);
assert.equal(existsSync(path.join(layout.parseDirectory, 'document.md')), true);
assert.equal(existsSync(path.join(layout.parseDirectory, 'line-layout.jsonl')), true);
assert.equal(existsSync(path.join(layout.parseDirectory, 'blocks.jsonl')), true);
assert.equal(existsSync(path.join(layout.parseDirectory, 'parse-report.json')), true);
const firstBlock = JSON.parse(readFileSync(path.join(layout.parseDirectory, 'blocks.jsonl'), 'utf8').split('\n')[0]);
assert.equal(firstBlock.kind, 'heading');
assert.equal(firstBlock.rawText, '# 第 0 节');

await assert.rejects(
  () => runMineruPdfParse({ inputPath: sourcePath, outputDir: tempDirectory, documentId: 'doc-pdf-p2', endpoint: '', apiKey: '', signal: new AbortController().signal }),
  (error) => error?.code === 'MINERU_KEY_REQUIRED',
);

const pdfPath = path.join(documentsDir, 'sample.pdf');
writeFileSync(pdfPath, '%PDF-1.7\nfixture', 'utf8');
const zipBytes = createStoredZip('full.md', '# MinerU 标题\n\n解析正文');
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers, body: init.body });
  if (String(url).endsWith('/file-urls/batch')) return new Response(JSON.stringify({ code: 0, data: { batch_id: 'batch-p2', file_urls: ['https://mineru.test/upload'] } }), { status: 200 });
  if (String(url) === 'https://mineru.test/upload') return new Response(null, { status: 200 });
  if (String(url).endsWith('/extract-results/batch/batch-p2')) return new Response(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://mineru.test/result.zip' }] } }), { status: 200 });
  if (String(url) === 'https://mineru.test/result.zip') return new Response(zipBytes, { status: 200 });
  throw new Error(`unexpected test URL: ${String(url)}`);
};
try {
  const mineruTemp = createParseTempDirectory(prepareParseLayout(libraryDir, { ...document, id: 'doc-pdf-p2', name: 'sample.pdf', relativePath: 'documents/sample.pdf', absolutePath: pdfPath, extension: '.pdf', sizeBytes: 16, contentHash: 'b'.repeat(64) }), 'job-mineru-p2');
  const mineruResult = await runMineruPdfParse({ inputPath: pdfPath, outputDir: mineruTemp, documentId: 'doc-pdf-p2', endpoint: 'https://mineru.test/api/v4', apiKey: 'test-secret', signal: new AbortController().signal });
  assert.equal(mineruResult.counts.blocks, 2);
  assert.equal(JSON.parse(readFileSync(path.join(mineruTemp, 'parse-report.json'), 'utf8')).engine, 'mineru');
  const artifactText = readFileSync(path.join(mineruTemp, 'document.md'), 'utf8') + readFileSync(path.join(mineruTemp, 'blocks.jsonl'), 'utf8');
  assert.equal(artifactText.includes('test-secret'), false, 'MinerU key must never enter artifacts');
  assert.equal(requests.some((request) => request.method === 'POST' && String(request.body).includes('"model_version":"vlm"')), true);
  assert.equal(requests.some((request) => request.method === 'PUT' && request.url.endsWith('/upload')), true);
} finally {
  globalThis.fetch = originalFetch;
}

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-p2: routing, streamed direct artifacts, cache validation, and MinerU key boundary passed');

function createStoredZip(fileName, content) {
  const name = Buffer.from(fileName, 'utf8');
  const body = Buffer.from(content, 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + body.length, 16);
  return Buffer.concat([local, body, central, end]);
}
