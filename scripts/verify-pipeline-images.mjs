import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
// 每次运行使用唯一 outDir：新写入的 .jpg 会被 Windows 杀软实时扫描短暂锁住，
// 固定目录会让上次残留的锁定图片污染本次清理与 temp 复用，导致偶发 EPERM。
const outDir = path.join(rootDir, '.package-staging', `verify-pipeline-images-${process.pid}-${Date.now()}`);
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(32, 7), Buffer.from([0xff, 0xd9])]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { createParseImageSink, planDirectMarkdownImages, readParseImagesManifest, rewriteMarkdownImageReferences, collectMarkdownImageReferences } from './electron/pipeline/parseImages';
      export { runDirectTextParse } from './electron/pipeline/textStage';
      export { runMineruPdfParse } from './electron/pipeline/mineruClient';
      export { prepareParseLayout, commitParseStage, isParseCacheValid, createParseTempDirectory } from './electron/pipeline/artifactStore';
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
  collectMarkdownImageReferences,
  commitParseStage,
  createParseImageSink,
  createParseTempDirectory,
  isParseCacheValid,
  planDirectMarkdownImages,
  prepareParseLayout,
  readParseImagesManifest,
  rewriteMarkdownImageReferences,
  runDirectTextParse,
  runMineruPdfParse,
} = await import(pathToFileURL(outFile).href);

// 1) sink 基础契约：内容寻址命名、去重、跳过原因与引用改写工具。
const unitDir = path.join(outDir, 'unit');
mkdirSync(unitDir, { recursive: true });
const unitSink = createParseImageSink(unitDir);
const firstRef = unitSink.saveBuffer(PNG_BYTES, 'image/png', { kind: 'docx-embedded', ref: 'word/media/image1.png' });
const secondRef = unitSink.saveBuffer(PNG_BYTES, undefined, { kind: 'docx-embedded', ref: 'word/media/image2.png' });
assert.equal(firstRef, `images/${sha256(PNG_BYTES)}.png`);
assert.equal(firstRef, secondRef, '相同字节必须去重到同一内容寻址名');
assert.equal(readdirSync(path.join(unitDir, 'images')).length, 1);
assert.equal(unitSink.saveBuffer(Buffer.from('not-an-image'), undefined, { kind: 'library-copy', ref: 'bad' }), null);
assert.equal(unitSink.saveBuffer(Buffer.concat([PNG_BYTES, Buffer.alloc(32 * 1024 * 1024)]), 'image/png', { kind: 'library-copy', ref: 'huge' }), null);
unitSink.recordSkip('https://example.com/a.png', 'remote-url');
const unitManifest = unitSink.manifest();
assert.deepEqual(unitManifest.skipped.map((entry) => entry.reason), ['unsupported-type', 'too-large', 'remote-url']);
assert.equal(unitManifest.images.length, 1);
assert.deepEqual(collectMarkdownImageReferences('![a](<images/a b.png>) 与 ![c](images/c.png "标题")'), ['images/a b.png', 'images/c.png']);
assert.equal(
  rewriteMarkdownImageReferences('![c](images/c.png "标题")', new Map([['images/c.png', 'images/deadbeef.png']])),
  '![c](images/deadbeef.png "标题")',
);

// 2) MinerU 路由：结果包内 images/ 必须落盘，full.md 引用改写为内容寻址名。
const pdfPath = path.join(documentsDir, 'sample.pdf');
writeFileSync(pdfPath, '%PDF-1.7\nfixture', 'utf8');
const zipBytes = createStoredZip([
  ['full.md', '# MinerU 图片\n\n![](images/photo.jpg)\n\n正文\n'],
  ['images/photo.jpg', JPG_BYTES],
]);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/file-urls/batch')) return new Response(JSON.stringify({ code: 0, data: { batch_id: 'batch-img', file_urls: ['https://mineru.test/upload'] } }), { status: 200 });
  if (String(url) === 'https://mineru.test/upload') return new Response(null, { status: 200 });
  if (String(url).endsWith('/extract-results/batch/batch-img')) return new Response(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://mineru.test/result.zip' }] } }), { status: 200 });
  if (String(url) === 'https://mineru.test/result.zip') return new Response(zipBytes, { status: 200 });
  throw new Error(`unexpected test URL: ${String(url)}`);
};
let mineruLayout;
try {
  const mineruDocument = makeDocument('doc-img-pdf', 'sample.pdf', 'documents/sample.pdf', pdfPath, '.pdf', 'b'.repeat(64));
  mineruLayout = prepareParseLayout(libraryDir, mineruDocument);
  const mineruTemp = createParseTempDirectory(mineruLayout, 'job-img-mineru');
  const mineruResult = await runMineruPdfParse({ inputPath: pdfPath, outputDir: mineruTemp, documentId: mineruDocument.id, endpoint: 'https://mineru.test/api/v4', apiKey: 'test-secret', signal: new AbortController().signal });
  assert.equal(mineruResult.counts.images, 1);
  const expectedJpgName = `${sha256(JPG_BYTES)}.jpg`;
  const mineruManifest = readParseImagesManifest(mineruTemp);
  assert.equal(mineruManifest.images.length, 1);
  assert.equal(mineruManifest.images[0].name, expectedJpgName);
  assert.equal(mineruManifest.images[0].origin.kind, 'mineru-zip');
  assert.equal(mineruManifest.images[0].origin.ref, 'images/photo.jpg');
  assert.equal(readFileSync(path.join(mineruTemp, 'images', expectedJpgName)).equals(JPG_BYTES), true);
  const mineruMarkdown = readFileSync(path.join(mineruTemp, 'document.md'), 'utf8');
  assert.match(mineruMarkdown, new RegExp(`!\\[\\]\\(images/${expectedJpgName}\\)`, 'u'));
  assert.equal(mineruMarkdown.includes('photo.jpg'), false, 'MinerU 原始图片名必须被改写');
  await commitParseStage(mineruLayout, mineruTemp);
  assert.equal(await isParseCacheValid(mineruLayout), true);
  rmSync(path.join(mineruLayout.parseDirectory, 'images', expectedJpgName), { force: true });
  assert.equal(await isParseCacheValid(mineruLayout), false, '图片缺失必须使 parse 缓存失效');
} finally {
  globalThis.fetch = originalFetch;
}

// 3) direct 路由：库内相对图片采纳进 images/，远程与缺失引用记入 skipped。
const notesPath = path.join(documentsDir, 'notes.md');
mkdirSync(path.join(documentsDir, 'images'), { recursive: true });
writeFileSync(path.join(documentsDir, 'images', 'pic.png'), PNG_BYTES);
writeFileSync(notesPath, ['# 图片笔记', '', '![local](images/pic.png)', '', '![remote](https://example.com/x.png)', '', '![missing](images/gone.png)', ''].join('\n'), 'utf8');
const directDocument = makeDocument('doc-img-md', 'notes.md', 'documents/notes.md', notesPath, '.md', 'c'.repeat(64));
const directLayout = prepareParseLayout(libraryDir, directDocument);
const directTemp = createParseTempDirectory(directLayout, 'job-img-direct');
const directSink = createParseImageSink(directTemp);
planDirectMarkdownImages({ sourcePath: notesPath, libraryPath: libraryDir, sink: directSink });
const expectedPngName = `${sha256(PNG_BYTES)}.png`;
assert.equal(directSink.rewriteMap().get('images/pic.png'), `images/${expectedPngName}`);
const directManifestBefore = directSink.manifest();
assert.deepEqual(directManifestBefore.skipped.map((entry) => entry.reason).sort(), ['remote-url', 'unreadable']);
const directResult = await runDirectTextParse({
  inputPath: notesPath,
  outputDir: directTemp,
  extension: '.md',
  signal: new AbortController().signal,
  imageRewrites: directSink.rewriteMap(),
  extraCounts: { images: directSink.savedCount(), imagesSkipped: directSink.skippedCount() },
});
assert.equal(directResult.counts.images, 1);
assert.equal(directResult.counts.imagesSkipped, 2);
const directMarkdown = readFileSync(path.join(directTemp, 'document.md'), 'utf8');
assert.match(directMarkdown, new RegExp(`!\\[local\\]\\(images/${expectedPngName}\\)`, 'u'));
assert.match(directMarkdown, /!\[remote\]\(https:\/\/example\.com\/x\.png\)/u, '远程引用必须原样保留');
const directBlocks = readFileSync(path.join(directTemp, 'blocks.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
assert.ok(directBlocks.some((block) => block.kind === 'image'), '图片行必须识别为 image 块');
directSink.writeManifest(directTemp);
await commitParseStage(directLayout, directTemp);
assert.equal(await isParseCacheValid(directLayout), true);
assert.equal(existsSync(path.join(directLayout.parseDirectory, 'images', expectedPngName)), true, '库内图片必须复制到工作区流水线目录');

// 4) 源图变更必须使 direct 缓存失效（库内来源快照比对）。
writeFileSync(path.join(documentsDir, 'images', 'pic.png'), Buffer.concat([PNG_BYTES, Buffer.from([0x00])]));
assert.equal(await isParseCacheValid(directLayout), false, '源图变更后 parse 缓存必须失效');

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-images: sink contract, MinerU zip images, direct library adoption and cache invalidation passed');

function makeDocument(id, name, relativePath, absolutePath, extension, contentHash) {
  return {
    id,
    name,
    relativePath,
    absolutePath,
    extension,
    sizeBytes: 16,
    addedAt: new Date().toISOString(),
    contentHash,
    vectorState: 'pending',
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [fileName, content] of entries) {
    const name = Buffer.from(fileName, 'utf8');
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
