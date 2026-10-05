import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import JSZip from 'jszip';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging');
mkdirSync(stagingRoot, { recursive: true });
const verificationDirectory = mkdtempSync(path.join(stagingRoot, 'trellora-assistant-doc-verify-'));
const parserBundle = path.join(verificationDirectory, 'parser.cjs');
const providerBundle = path.join(verificationDirectory, 'provider.cjs');
const workerBundle = path.join(verificationDirectory, 'mammothWorker.js');
const pdfWorkerBundle = path.join(verificationDirectory, 'pdf.worker.mjs');
const pdfPath = path.join(verificationDirectory, 'assistant-fixture.pdf');
const scannedPdfPath = path.join(verificationDirectory, 'assistant-scanned-fixture.pdf');
const docxPath = path.join(verificationDirectory, 'assistant-fixture.docx');
const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

try {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantDocumentAttachmentParser.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: parserBundle }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'attachmentContextProvider.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: providerBundle }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'pipeline', 'mammothWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerBundle }),
    build({ entryPoints: [path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: pdfWorkerBundle }),
  ]);
  writeFileSync(pdfPath, createMinimalPdf('PDF attachment searchable sentinel'));
  writeFileSync(scannedPdfPath, createMinimalPdf(''));
  writeFileSync(docxPath, await createFixtureDocx('DOCX attachment searchable sentinel'));
  const originalHashes = new Map([
    [pdfPath, sha256(readFileSync(pdfPath))],
    [scannedPdfPath, sha256(readFileSync(scannedPdfPath))],
    [docxPath, sha256(readFileSync(docxPath))],
  ]);

  const attachments = [
    { kind: 'document', attachmentId: 'document-pdf-fixture', path: pdfPath, name: path.basename(pdfPath), mimeType: 'application/pdf', sizeBytes: statSync(pdfPath).size },
    { kind: 'document', attachmentId: 'document-docx-fixture', path: docxPath, name: path.basename(docxPath), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: statSync(docxPath).size },
  ];
  const require = createRequire(import.meta.url);
  const { collectAiTransportImageHashes, materializeAssistantDocumentImages, parseAssistantDocumentAttachments } = require(parserBundle);
  const { AttachmentContextProvider } = require(providerBundle);
  const progress = [];
  const parsed = await parseAssistantDocumentAttachments(attachments, {
    signal: new AbortController().signal,
    mammothWorkerScriptPath: workerBundle,
    tempRoot: verificationDirectory,
    onProgress: (message) => progress.push(message),
  });

  assert.match(parsed.documentTextByAttachmentId.get('document-pdf-fixture'), /PDF attachment searchable sentinel/u);
  assert.match(parsed.documentTextByAttachmentId.get('document-docx-fixture'), /DOCX attachment searchable sentinel/u);
  const docxText = parsed.documentTextByAttachmentId.get('document-docx-fixture');
  assert.match(docxText, /\[\[DOCX_IMAGE:document-docx-fixture:[a-f0-9]{16}\]\]/u, 'DOCX 图片引用应改写为稳定占位符');
  assert.doesNotMatch(docxText, /images\//u, '模型正文不应依赖 DOCX 临时图片路径');
  const docxImages = parsed.documentImagesByAttachmentId.get('document-docx-fixture');
  assert.equal(docxImages.length, 1, '应登记 Mammoth 提取出的 DOCX 图片');
  assert.ok(existsSync(docxImages[0].absolutePath), 'ParseSession 存活期间 DOCX 图片应可读取');
  assert.equal(progress.length, 2);
  const provider = new AttachmentContextProvider(attachments, {
    documentTextByAttachmentId: parsed.documentTextByAttachmentId,
    documentImagesByAttachmentId: parsed.documentImagesByAttachmentId,
  });
  assert.ok(provider.listMetadata().every((metadata) => metadata.kind === 'document' && metadata.searchable), 'PDF / DOCX 解析后必须成为可搜索附件');
  const hits = provider.search('searchable sentinel');
  assert.equal(new Set(hits.map((hit) => hit.attachmentId)).size, 2, '查询应同时命中 PDF 与 DOCX');
  assert.ok(hits.every((hit) => /searchable sentinel/u.test(provider.readRange(hit).text)));
  const naturalVisualQuestion = '这个附件内的图片是啥？';
  const docxReads = provider.search(naturalVisualQuestion).map((hit) => provider.readRange(hit));
  assert.ok(docxReads.some((read) => read.imageIds.includes(docxImages[0].imageId)), 'DOCX 命中范围应关联稳定图片标识');
  const selectedDocxImages = provider.selectDocumentImages(docxReads, naturalVisualQuestion);
  const materializedDocxImages = materializeAssistantDocumentImages(selectedDocxImages);
  assert.equal(materializedDocxImages.length, 1, '相关 DOCX 图片应进入有界 VLM 输入');
  assert.match(materializedDocxImages[0].transport.dataUrl, /^data:image\/png;base64,/u);

  const distantImageLine = 121;
  const distantImageText = [
    ...Array.from({ length: distantImageLine - 1 }, (_, index) => `正文第 ${index + 1} 行`),
    docxImages[0].placeholder,
  ].join('\n');
  const distantImageProvider = new AttachmentContextProvider([attachments[1]], {
    documentTextByAttachmentId: new Map([[attachments[1].attachmentId, distantImageText]]),
    documentImagesByAttachmentId: new Map([[
      attachments[1].attachmentId,
      [{ ...docxImages[0], lineNumbers: [distantImageLine] }],
    ]]),
  });
  const leadingReads = distantImageProvider.search(naturalVisualQuestion).map((hit) => distantImageProvider.readRange(hit));
  assert.equal(leadingReads.length, 1, '自然看图问法应在无关键词命中时触发附件正文读取');
  assert.deepEqual(leadingReads[0].imageIds, [], '首段读取可不包含位于文档后半段的图片');
  assert.equal(
    distantImageProvider.selectDocumentImages(leadingReads, naturalVisualQuestion)[0]?.imageId,
    docxImages[0].imageId,
    '明确看图时，已读范围未覆盖图片也应按文档顺序补选首图',
  );
  const ownedDocxImagePath = docxImages[0].absolutePath;
  parsed.dispose();
  assert.equal(existsSync(ownedDocxImagePath), false, 'dispose 后应清理 DOCX 临时图片');

  const scannedAttachment = {
    kind: 'document',
    attachmentId: 'document-scanned-fixture',
    path: scannedPdfPath,
    name: path.basename(scannedPdfPath),
    mimeType: 'application/pdf',
    sizeBytes: statSync(scannedPdfPath).size,
  };
  await assert.rejects(
    () => parseAssistantDocumentAttachments([scannedAttachment], {
      signal: new AbortController().signal,
      tempRoot: verificationDirectory,
    }),
    /配置并授权 MinerU/u,
    '未授权时扫描 PDF 不得静默上传',
  );
  let mineruCalls = 0;
  const mineruProgress = [];
  const scannedParsed = await parseAssistantDocumentAttachments([scannedAttachment], {
    signal: new AbortController().signal,
    tempRoot: verificationDirectory,
    mineru: {
      endpoint: 'https://mineru.example/api/v4',
      apiKey: 'verification-secret',
      cloudParsingConsent: true,
    },
    mineruRunner: async (options) => {
      mineruCalls += 1;
      assert.equal(options.inputPath, scannedPdfPath);
      assert.equal(options.documentId, scannedAttachment.attachmentId);
      assert.equal(options.endpoint, 'https://mineru.example/api/v4');
      assert.equal(options.apiKey, 'verification-secret');
      options.onProgress?.({ completed: 1, total: 1, message: 'MinerU fixture 完成。' });
      const image = fixturePng;
      const imageHash = sha256(image);
      const relativePath = `images/${imageHash}.png`;
      mkdirSync(path.join(options.outputDir, 'images'), { recursive: true });
      writeFileSync(path.join(options.outputDir, relativePath), image);
      writeFileSync(path.join(options.outputDir, 'document.md'), `# 图表章节\nMinerU OCR searchable sentinel\n![计算图](${relativePath})\n图中展示了关键指标。\n`, 'utf8');
      writeFileSync(path.join(options.outputDir, 'images-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        stage: 'parse',
        images: [{
          name: `${imageHash}.png`,
          relativePath,
          sha256: imageHash,
          bytes: image.length,
          mime: 'image/png',
          origin: { kind: 'mineru-zip', ref: 'images/diagram.png' },
        }],
        skipped: [],
        generatedAt: new Date().toISOString(),
      }), 'utf8');
      return { counts: { pages: 1 } };
    },
    onProgress: (message) => mineruProgress.push(message),
  });
  assert.equal(mineruCalls, 1, '扫描 PDF 在已授权且已配置时应调用 MinerU 一次');
  const mineruText = scannedParsed.documentTextByAttachmentId.get(scannedAttachment.attachmentId);
  assert.match(mineruText, /MinerU OCR searchable sentinel/u);
  assert.match(mineruText, /\[\[PDF_IMAGE:document-scanned-fixture:[a-f0-9]{16}\]\]/u, 'MinerU 图片引用应改写为稳定占位符');
  assert.doesNotMatch(mineruText, /images\//u, '模型正文不应依赖临时图片路径');
  const mineruImages = scannedParsed.documentImagesByAttachmentId.get(scannedAttachment.attachmentId);
  assert.equal(mineruImages.length, 1, '应登记 MinerU 提取出的 PDF 图片');
  assert.ok(existsSync(mineruImages[0].absolutePath), 'ParseSession 存活期间图片应可读取');
  const scannedProvider = new AttachmentContextProvider([scannedAttachment], {
    documentTextByAttachmentId: scannedParsed.documentTextByAttachmentId,
    documentImagesByAttachmentId: scannedParsed.documentImagesByAttachmentId,
  });
  const scannedVisualQuestion = '这个 PDF 里的图是什么？';
  const scannedReads = scannedProvider.search(scannedVisualQuestion).map((hit) => scannedProvider.readRange(hit));
  assert.deepEqual(scannedReads[0].imageIds, [mineruImages[0].imageId], '命中范围应关联稳定图片标识');
  const selectedImages = scannedProvider.selectDocumentImages(scannedReads, scannedVisualQuestion);
  const materializedImages = materializeAssistantDocumentImages(selectedImages);
  assert.equal(materializedImages.length, 1, '相关 PDF 图片应进入有界 VLM 输入');
  assert.match(materializedImages[0].transport.dataUrl, /^data:image\/png;base64,/u);
  assert.equal(materializeAssistantDocumentImages(selectedImages, {
    excludedSha256: collectAiTransportImageHashes([materializedImages[0].transport]),
  }).length, 0, '显式图片应优先并与 PDF 派生图片按内容去重');
  const ownedImagePath = mineruImages[0].absolutePath;
  scannedParsed.dispose();
  assert.equal(existsSync(ownedImagePath), false, 'dispose 后应清理 MinerU 临时图片');
  assert.ok(mineruProgress.some((message) => /正在使用 MinerU/u.test(message)));
  assert.ok(mineruProgress.some((message) => /MinerU fixture 完成/u.test(message)));
  assert.equal(sha256(readFileSync(pdfPath)), originalHashes.get(pdfPath), 'PDF 原文件不得被修改');
  assert.equal(sha256(readFileSync(scannedPdfPath)), originalHashes.get(scannedPdfPath), '扫描 PDF 原文件不得被修改');
  assert.equal(sha256(readFileSync(docxPath)), originalHashes.get(docxPath), 'DOCX 原文件不得被修改');
  console.log('assistant-document-attachments 验证通过：PDF.js / MinerU / Mammoth 正文与图片占位符均已解析，自然看图问法和远距离图片补选可有界直传且原文件不变。');
} finally {
  stop();
  rmSync(verificationDirectory, { recursive: true, force: true });
}

async function createFixtureDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
  zip.file('word/media/image1.png', fixturePng);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
  <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  <w:p><w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="952500" cy="952500"/>
      <wp:docPr id="1" name="Image 1" descr="DOCX fixture image"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p><w:sectPr/>
</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function createMinimalPdf(text) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n%\x80\x81\x82\x83\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
