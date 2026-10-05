import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import JSZip from 'jszip';

const rootDir = process.cwd();
const verificationDirectory = mkdtempSync(path.join(os.tmpdir(), 'menghan-mammoth-docx-'));
const sourcePath = path.join(verificationDirectory, 'mammoth-轻量解析验证.docx');
const outputDirectory = path.join(verificationDirectory, 'output');
const stageBundle = path.join(verificationDirectory, 'mammothStage.cjs');
const workerBundle = path.join(verificationDirectory, 'mammothWorker.js');
const FIXTURE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'pipeline', 'mammothStage.ts')],
      bundle: true,
      format: 'cjs',
      outfile: stageBundle,
      platform: 'node',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'pipeline', 'mammothWorker.ts')],
      bundle: true,
      format: 'cjs',
      outfile: workerBundle,
      platform: 'node',
    }),
  ]);
  writeFileSync(sourcePath, await createFixtureDocx());
  const originalHash = sha256(readFileSync(sourcePath));
  mkdirSync(outputDirectory, { recursive: true });

  const require = createRequire(import.meta.url);
  const { runMammothDocxParse } = require(stageBundle);
  const progress = [];
  const result = await runMammothDocxParse({
    inputPath: sourcePath,
    outputDir: outputDirectory,
    sourceName: path.basename(sourcePath),
    signal: new AbortController().signal,
    workerScriptPath: workerBundle,
    onProgress: (event) => progress.push(event),
  });

  const markdown = readFileSync(path.join(outputDirectory, 'document.md'), 'utf8');
  const blocks = jsonLines(path.join(outputDirectory, 'blocks.jsonl'));
  const layout = jsonLines(path.join(outputDirectory, 'line-layout.jsonl'));
  const report = JSON.parse(readFileSync(path.join(outputDirectory, 'parse-report.json'), 'utf8'));
  const imagesManifest = JSON.parse(readFileSync(path.join(outputDirectory, 'images-manifest.json'), 'utf8'));
  assert.match(markdown, /^# Mammoth 轻量解析验证/mu);
  assert.match(markdown, /这是一个不依赖 Python 文档解析引擎的 DOCX。/u);
  assert.match(markdown, /\| 列名 \| 内容 \|/u);
  assert.ok(blocks.some((block) => block.kind === 'heading'));
  assert.ok(blocks.some((block) => block.kind === 'table'));
  assert.equal(layout.length, blocks.length);
  assert.equal(markdown.split(/\r?\n/u).filter(Boolean).length, blocks.length);
  assert.ok(layout.some((line) => line.blankBefore === true));
  assert.equal(report.engine, 'mammoth');
  assert.equal(result.counts.blocks, blocks.length);
  assert.equal(progress.at(-1)?.completed, 1);
  assert.equal(sha256(readFileSync(sourcePath)), originalHash, 'Mammoth 阶段不得修改原始 DOCX');

  const pngBytes = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
  const expectedImageName = `${sha256(pngBytes)}.png`;
  assert.match(markdown, new RegExp(`!\\[\\]\\(images/${expectedImageName}\\)`, 'u'), '内嵌图片必须改写为 images/ 下的内容寻址引用');
  assert.equal(markdown.includes('[内嵌图片]'), false, '已保存的内嵌图片不得保留占位符');
  assert.ok(blocks.some((block) => block.kind === 'image'), '图片行必须识别为 image 块');
  assert.equal(readFileSync(path.join(outputDirectory, 'images', expectedImageName)).equals(pngBytes), true, '内嵌图片字节必须原样落盘');
  assert.equal(imagesManifest.images.length, 1);
  assert.equal(imagesManifest.images[0].origin.kind, 'docx-embedded');
  assert.equal(imagesManifest.images[0].mime, 'image/png');
  assert.equal(report.counts.images, 1);
  console.log(`verify-mammoth-docx: passed (${blocks.length} blocks, ${Buffer.byteLength(markdown)} markdown bytes, ${imagesManifest.images.length} image)`);
} finally {
  rmSync(verificationDirectory, { recursive: true, force: true });
}

async function createFixtureDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
  zip.file('word/media/image1.png', Buffer.from(FIXTURE_PNG_BASE64, 'base64'));
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Mammoth 轻量解析验证</w:t></w:r></w:p>
    <w:p><w:r><w:t>这是一个不依赖 Python 文档解析引擎的 DOCX。</w:t></w:r></w:p>
    <w:p><w:r><w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="952500" cy="952500"/>
        <wp:docPr id="1" name="Image 1"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>列名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>解析器</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Mammoth</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function jsonLines(filePath) {
  return readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
