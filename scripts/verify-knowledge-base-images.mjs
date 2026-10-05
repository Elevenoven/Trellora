import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging');
mkdirSync(stagingRoot, { recursive: true });
const verificationDirectory = mkdtempSync(path.join(stagingRoot, 'trellora-knowledge-images-verify-'));
const resolverBundle = path.join(verificationDirectory, 'knowledgeBaseImageResolver.cjs');
const engineBundle = path.join(verificationDirectory, 'reactEngine.cjs');
const registryBundle = path.join(verificationDirectory, 'toolRegistry.cjs');

try {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'knowledgeBaseImageResolver.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: resolverBundle }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'reactAgent', 'reactEngine.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: engineBundle }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'reactAgent', 'toolRegistry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: registryBundle }),
  ]);

  const require = createRequire(import.meta.url);
  const { KnowledgeBaseImageResolver, renderKnowledgeBaseImageTransportIndex } = require(resolverBundle);
  const { runReActLoop } = require(engineBundle);
  const { ReActToolRegistry } = require(registryBundle);

  const libraryPath = path.join(verificationDirectory, 'library');
  const documentId = 'document-fixture';
  const contentHash = 'a'.repeat(64);
  const pipelineFingerprint = 'b'.repeat(64);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageHash = sha256(image);
  const imageReference = `images/${imageHash}.png`;
  const parseDirectory = path.join(libraryPath, '.menghan-meta', 'pipeline', documentId, contentHash, pipelineFingerprint, '01-parse');
  mkdirSync(path.join(parseDirectory, 'images'), { recursive: true });
  writeFileSync(path.join(parseDirectory, imageReference), image);
  writeFileSync(path.join(parseDirectory, 'images-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    stage: 'parse',
    images: [{
      name: `${imageHash}.png`,
      relativePath: imageReference,
      sha256: imageHash,
      bytes: image.length,
      mime: 'image/png',
      origin: { kind: 'docx-embedded', ref: 'word/media/image1.png' },
    }],
    skipped: [],
    generatedAt: new Date().toISOString(),
  }), 'utf8');
  writeFileSync(path.join(path.dirname(parseDirectory), 'pipeline-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    documentId,
    documentName: 'fixture.docx',
    sourceContentHash: contentHash,
    sourceRelativePath: 'documents/fixture.docx',
    route: 'mammoth',
    engine: 'mammoth-1.12.1-p1',
    protocolVersion: 1,
    pipelineFingerprint,
    updatedAt: new Date().toISOString(),
    stages: { parse: { stageKey: 'parse-fixture', status: 'SUCCEEDED', updatedAt: new Date().toISOString() } },
  }), 'utf8');

  const document = {
    id: documentId,
    name: 'fixture.docx',
    relativePath: 'documents/fixture.docx',
    absolutePath: path.join(libraryPath, 'documents', 'fixture.docx'),
    extension: '.docx',
    sizeBytes: 1,
    addedAt: new Date().toISOString(),
    contentHash,
    vectorState: 'indexed',
  };
  const initialImage = { dataUrl: 'data:image/png;base64,aW5pdGlhbA==', mimeType: 'image/png', name: 'explicit.png' };
  const resolver = new KnowledgeBaseImageResolver(libraryPath, { documents: [document], initialImages: [initialImage] });
  const rawEvidence = [{ documentId, text: `# 图表\n![计算图](${imageReference})\n图中展示核心流程。`, sourceText: '可信原文' }];
  const first = resolver.resolve(rawEvidence);
  assert.equal(first.images.length, 1, '知识库解析产物图片应物化为一张新 VLM 输入');
  assert.match(first.images[0].dataUrl, /^data:image\/png;base64,/u);
  assert.match(first.evidence[0].text, /\[\[KNOWLEDGE_IMAGE:document-fixture:[a-f0-9]{16}\]\]/u);
  assert.doesNotMatch(first.evidence[0].text, /images\//u, '模型证据不应暴露本地图片相对路径');
  assert.equal(first.evidence[0].sourceText, '可信原文', '原文证据账本内容不得被视觉占位符覆盖');
  assert.equal(first.mappings[0].imageIndex, 2, '知识库图片应接在用户显式图片之后');
  assert.match(renderKnowledgeBaseImageTransportIndex(first.mappings), /视觉输入第 2 张=/u);

  const repeated = resolver.resolve(rawEvidence);
  assert.equal(repeated.images.length, 0, '同一轮重复命中相同图片不得重复传输');
  assert.equal(repeated.mappings[0].imageIndex, 2, '重复命中必须沿用稳定视觉输入序号');

  const deduped = new KnowledgeBaseImageResolver(libraryPath, {
    documents: [document],
    initialImages: [{ dataUrl: `data:image/png;base64,${image.toString('base64')}`, mimeType: 'image/png', name: 'same.png' }],
  }).resolve(rawEvidence);
  assert.equal(deduped.images.length, 0, '显式上传的同图应优先，知识库不得重复附加');
  assert.equal(deduped.mappings[0].imageIndex, 1);

  const originalImagePath = path.join(parseDirectory, imageReference);
  const tampered = Buffer.from(image);
  tampered[tampered.length - 1] ^= 0xff;
  writeFileSync(originalImagePath, tampered);
  const rejected = new KnowledgeBaseImageResolver(libraryPath, { documents: [document] }).resolve(rawEvidence);
  assert.equal(rejected.images.length, 0, '字节哈希不匹配的解析图片必须拒绝');
  assert.equal(rejected.evidence[0].text, rawEvidence[0].text, '拒绝图片时保留原证据文本，不伪造视觉占位符');
  writeFileSync(originalImagePath, image);

  const imagesManifestPath = path.join(parseDirectory, 'images-manifest.json');
  const safeImagesManifest = JSON.parse(readFileSync(imagesManifestPath, 'utf8'));
  const unsafeImagesManifest = structuredClone(safeImagesManifest);
  unsafeImagesManifest.images[0].relativePath = '../outside.png';
  unsafeImagesManifest.images[0].origin.ref = '../outside.png';
  writeFileSync(imagesManifestPath, JSON.stringify(unsafeImagesManifest), 'utf8');
  const unsafeEvidence = [{ documentId, text: '![越界图](../outside.png)', sourceText: '![越界图](../outside.png)' }];
  const pathRejected = new KnowledgeBaseImageResolver(libraryPath, { documents: [document] }).resolve(unsafeEvidence);
  assert.equal(pathRejected.images.length, 0, '越过 parse/images 内容寻址目录的清单路径必须拒绝');
  assert.equal(pathRejected.evidence[0].text, unsafeEvidence[0].text);
  writeFileSync(imagesManifestPath, JSON.stringify(safeImagesManifest), 'utf8');

  const registry = new ReActToolRegistry();
  const toolImage = first.images[0];
  registry.register({
    name: 'knowledge_search',
    description: '返回带图证据。',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      ok: true,
      observation: '<result>[[KNOWLEDGE_IMAGE:document-fixture:test]]</result>',
      message: '已返回带图证据。',
      images: [toolImage],
    }),
  });
  const calls = [];
  const traces = [];
  const result = await runReActLoop({
    systemPrompt: '只基于工具证据回答。',
    history: [],
    question: '图中是什么？',
    model: 'fixture-vlm',
    config: { kind: 'ollama' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        calls.push(request.messages.map((message) => ({ ...message, ...(message.images ? { images: [...message.images] } : {}) })));
        if (calls.length === 1) return { content: '', toolCalls: [{ id: 'call-1', name: 'knowledge_search', arguments: {} }] };
        return { content: '图中展示了核心流程。[1]', toolCalls: [] };
      },
    },
    registry,
    toolContext: {},
    signal: new AbortController().signal,
    onTrace: (entry) => traces.push(entry),
  });
  assert.equal(result.finalAnswer, '图中展示了核心流程。[1]');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].find((message) => message.role === 'user').images, undefined, '工具执行前不应虚构知识库图片');
  assert.equal(calls[1].find((message) => message.role === 'user').images?.length, 1, '工具返回图片必须进入下一轮模型视觉上下文');
  const toolTrace = traces.find((entry) => entry.action === 'tool' && entry.status === 'completed');
  assert.equal(toolTrace.detail.imageCount, 1, '轨迹只记录图片数量');
  assert.equal(JSON.stringify(toolTrace).includes(toolImage.dataUrl), false, '轨迹不得记录图片 data URL');

  const wiringFiles = [
    'electron/knowledge/knowledgeTools/knowledgeSearchTool.ts',
    'electron/knowledge/knowledgeTools/grepChunksTool.ts',
    'electron/knowledge/knowledgeTools/listKnowledgeChunksTool.ts',
    'electron/knowledge/knowledgeTools/graphLocalSearchTool.ts',
    'electron/wiki/wikiTools/wikiNodeSearchTool.ts',
    'electron/wiki/wikiTools/wikiSearchDocumentTool.ts',
    'electron/wiki/wikiTools/wikiReadNodeTool.ts',
    'electron/wiki/wikiTools/wikiGrepNodeTool.ts',
  ];
  for (const relativePath of wiringFiles) {
    const source = readFileSync(path.join(rootDir, relativePath), 'utf8');
    assert.match(source, /resolveEvidenceVisuals/u, `${relativePath} 必须解析证据图片`);
    assert.match(source, /visuals\.images/u, `${relativePath} 必须返回新物化图片`);
  }
  assert.match(readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8'), /images: visualResolution\.images/u, '知识库直接问答必须把图片交给 VLM');
  assert.match(readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentTurn.ts'), 'utf8'), /resolveEvidenceVisuals:/u, '知识库 ReAct 必须装配图片解析器');
  assert.match(readFileSync(path.join(rootDir, 'electron', 'wiki', 'wikiNodeAgentTurn.ts'), 'utf8'), /KnowledgeBaseImageResolver/u, 'Wiki 节点问答必须装配图片解析器');

  console.log('knowledge-base-images 验证通过：长期图片按当前哈希快照安全物化、占位符绑定、去重与 ReAct 次轮 VLM 传输均符合契约。');
} finally {
  stop();
  rmSync(verificationDirectory, { recursive: true, force: true });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
