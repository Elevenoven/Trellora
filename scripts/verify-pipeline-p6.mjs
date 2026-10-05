import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// This verifier covers the retained legacy artifact contract explicitly.
process.env.MENGHAN_PIPELINE_CHUNKING_V2 = '0';
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.p6');
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');
const fixturePath = path.join(rootDir, 'scripts', 'fixtures', 'pipeline-p6-tree-golden.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const config = { strategy: 'heading', targetChars: 200, overlapChars: 30, minChars: 40, maxChars: 300 };

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { prepareParseLayout, commitTreeStage, commitChunksStage, isStageCacheValid, removePipelineArtifacts, treeStageKey, chunksStageKey } from './electron/pipeline/artifactStore';
      export { structureConfigHash } from './electron/pipeline/structureConfig';
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
  chunksStageKey,
  commitChunksStage,
  commitTreeStage,
  isStageCacheValid,
  removePipelineArtifacts,
  prepareParseLayout,
  structureConfigHash,
  treeStageKey,
} = await import(pathToFileURL(outFile).href);

const sourcePath = path.join(documentsDir, 'p6-stability.md');
const allSignals = [
  ...fixture.signals,
  ...Array.from({ length: 5000 }, (_, index) => {
    const lineNo = index + 16;
    return {
      lineNo,
      type: 'BODY',
      text: `长文档正文第 ${lineNo} 行，用于验证重复运行、取消恢复和缓存边界。`,
      ruleId: 'fallback-body',
    };
  }),
  { lineNo: 5016, type: 'BODY', text: '长正文'.repeat(200), ruleId: 'fallback-body' },
];
const sourceText = allSignals.map((signal) => signal.text).join('\n');
writeFileSync(sourcePath, sourceText, 'utf8');
const document = {
  id: fixture.documentId,
  name: 'p6-stability.md',
  relativePath: 'documents/p6-stability.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: Buffer.byteLength(sourceText),
  addedAt: '2026-01-01T00:00:00.000Z',
  contentHash: fixture.contentHash,
  vectorState: 'pending',
};
const layout = prepareParseLayout(libraryDir, document, '', 'p4-stability', structureConfigHash(config));
mkdirSync(layout.ambiguityDirectory, { recursive: true });

const batchSize = 50;
const batches = [];
for (let index = 0; index < allSignals.length; index += batchSize) {
  const signals = allSignals.slice(index, index + batchSize).map((signal) => ({
    schemaVersion: 1,
    signalId: `s-${String(signal.lineNo).padStart(6, '0')}`,
    lineNo: signal.lineNo,
    type: signal.type,
    rawText: signal.text,
    normalizedText: signal.text,
    confidence: signal.type === 'BODY' ? 0.75 : 0.96,
    ruleId: signal.ruleId,
    source: { blockId: `b-${signal.lineNo}`, page: Math.ceil(signal.lineNo / 40) },
  }));
  batches.push({
    schemaVersion: 1,
    documentId: document.id,
    contentHash: document.contentHash,
    batchIndex: batches.length,
    firstLineNo: signals[0].lineNo,
    lastLineNo: signals[signals.length - 1].lineNo,
    contextText: signals.map((signal) => signal.normalizedText).join('\n'),
    ...(batches.length === 0 ? {
      documentTitle: {
        signalId: 's-title',
        lineNo: 0,
        type: 'DOCUMENT_TITLE',
        normalizedText: fixture.title,
      },
    } : {}),
    signals,
  });
}
writeFileSync(path.join(layout.ambiguityDirectory, 'ambiguity.jsonl'), `${batches.map((batch) => JSON.stringify(batch)).join('\n')}\n`, 'utf8');
writeFileSync(path.join(layout.ambiguityDirectory, 'ambiguity-report.json'), JSON.stringify({ counts: { signals: allSignals.length } }), 'utf8');

const treeA = path.join(layout.documentRoot, '.05-tree.tmp-p6-a');
const treeB = path.join(layout.documentRoot, '.05-tree.tmp-p6-b');
const treeResume = path.join(layout.documentRoot, '.05-tree.tmp-p6-resume');
const chunksA = path.join(layout.documentRoot, '.06-chunks.tmp-p6-a');
const chunksB = path.join(layout.documentRoot, '.06-chunks.tmp-p6-b');
const chunksResume = path.join(layout.documentRoot, '.06-chunks.tmp-p6-resume');
const pythonScript = String.raw`
import json, sys
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path.cwd()))
from pipeline_worker.structure_stage import run_structure_chunks_stage, run_structure_tree_stage

ambiguity_dir, tree_a, tree_b, tree_resume, chunks_a, chunks_b, chunks_resume, tree_key, chunks_key, document_id, content_hash, config_json, summary_path = sys.argv[1:]
config = json.loads(config_json)

def run_tree(input_dir, output_dir, cancel_after=None):
    cancel = Event()
    def on_progress(completed, total, unit, message):
        if cancel_after is not None and completed >= cancel_after:
            cancel.set()
    try:
        return run_structure_tree_stage(input_dir, output_dir, document_id, content_hash, cancel, on_progress, tree_key)
    except Exception as exc:
        if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
            raise
        checkpoint = json.loads((Path(output_dir) / 'checkpoint.json').read_text(encoding='utf-8'))
        assert checkpoint['complete'] is False
        assert (Path(output_dir) / 'structure.partial.jsonl').is_file()
        return None

def run_chunks(input_dir, output_dir, cancel_after=None):
    cancel = Event()
    def on_progress(completed, total, unit, message):
        if cancel_after is not None and completed >= cancel_after:
            cancel.set()
    try:
        return run_structure_chunks_stage(input_dir, output_dir, document_id, content_hash, config, cancel, on_progress, chunks_key)
    except Exception as exc:
        if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
            raise
        checkpoint = json.loads((Path(output_dir) / 'checkpoint.json').read_text(encoding='utf-8'))
        assert checkpoint['complete'] is False
        assert (Path(output_dir) / 'chunks.jsonl').is_file()
        return None

tree_counts_a = run_tree(ambiguity_dir, tree_a)
tree_counts_b = run_tree(ambiguity_dir, tree_b)
run_tree(ambiguity_dir, tree_resume, 100)
tree_counts_resume = run_tree(ambiguity_dir, tree_resume)

chunks_counts_a = run_chunks(tree_a, chunks_a)
chunks_counts_b = run_chunks(tree_a, chunks_b)
run_chunks(tree_a, chunks_resume, 200)
chunks_counts_resume = run_chunks(tree_a, chunks_resume)

assert tree_counts_a == tree_counts_b == tree_counts_resume
assert chunks_counts_a == chunks_counts_b == chunks_counts_resume
Path(summary_path).write_text(json.dumps({
    'tree': tree_counts_a,
    'chunks': chunks_counts_a,
}, ensure_ascii=False, indent=2), encoding='utf-8')
`;
const summaryPath = path.join(outDir, 'python-summary.json');
const pythonResult = spawnSync(String(process.env.PYTHON ?? 'python'), [
  '-c',
  pythonScript,
  layout.ambiguityDirectory,
  treeA,
  treeB,
  treeResume,
  chunksA,
  chunksB,
  chunksResume,
  treeStageKey(layout),
  chunksStageKey(layout),
  document.id,
  document.contentHash,
  JSON.stringify(config),
  summaryPath,
], {
  cwd: path.join(rootDir, 'pipeline-python'),
  encoding: 'utf8',
  windowsHide: true,
});
if (pythonResult.status !== 0) throw new Error(`P6 Python stability verification failed:\n${pythonResult.stdout}\n${pythonResult.stderr}`);

const volatileKeys = new Set(['generatedAt', 'updatedAt', 'validatedAt', 'startedAt', 'finishedAt', 'jobId']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !volatileKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function canonicalFile(filePath, jsonl = false) {
  const value = jsonl ? readJsonLines(filePath) : JSON.parse(readFileSync(filePath, 'utf8'));
  return JSON.stringify(canonical(value));
}

function assertStableStage(label, firstDirectory, secondDirectory, files) {
  for (const [fileName, jsonl] of files) {
    assert.equal(
      canonicalFile(path.join(firstDirectory, fileName), jsonl),
      canonicalFile(path.join(secondDirectory, fileName), jsonl),
      `${label} 的 ${fileName} 在重复/恢复运行后发生变化`,
    );
  }
}

function validateTree(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  assert.equal(byId.size, nodes.length, '树节点 nodeId 必须唯一');
  assert.equal(nodes.filter((node) => node.parentId === null).length, 1, '树必须只有一个根节点');
  assert.equal(byId.get('n-root')?.parentId, null, '根节点必须是 n-root');
  const childCounts = new Map();
  let previousLine = -1;
  for (const node of nodes) {
    assert.ok(Number.isInteger(node.firstLineNo) && Number.isInteger(node.lastLineNo));
    assert.ok(node.firstLineNo <= node.lastLineNo);
    assert.ok(node.firstLineNo >= previousLine, `节点 ${node.nodeId} 的行号不是单调序列`);
    previousLine = node.lastLineNo;
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      assert.ok(parent, `节点 ${node.nodeId} 的父节点不存在`);
      assert.equal(node.depth, parent.depth + 1, `节点 ${node.nodeId} 的 depth 与父节点不一致`);
      assert.ok(node.path.startsWith(parent.path), `节点 ${node.nodeId} 的 path 不是父路径的子路径`);
      childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    }
    if (node.type !== 'DOCUMENT_ROOT') {
      assert.ok(Array.isArray(node.sourceRefs) && node.sourceRefs.length > 0, `节点 ${node.nodeId} 缺少 sourceRefs`);
    }
    if (!['DOCUMENT_ROOT', 'DOCUMENT_TITLE'].includes(node.type)) {
      assert.ok(typeof node.signalId === 'string' && node.signalId.length > 0, `节点 ${node.nodeId} 缺少 signalId`);
    }
    const seen = new Set();
    let current = node;
    while (current.parentId !== null) {
      assert.ok(!seen.has(current.nodeId), `树中检测到环：${node.nodeId}`);
      seen.add(current.nodeId);
      current = byId.get(current.parentId);
      assert.ok(current, `树中存在不可达父节点：${node.nodeId}`);
    }
  }
  for (const node of nodes) assert.equal(node.childCount, childCounts.get(node.nodeId) ?? 0, `节点 ${node.nodeId} 的 childCount 不准确`);
  return byId;
}

function validateGoldenTree(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const expected of fixture.expectedTree) {
    const actual = byId.get(expected.nodeId);
    assert.ok(actual, `Golden Fixture 缺少节点 ${expected.nodeId}`);
    assert.deepEqual({
      nodeId: actual.nodeId,
      parentId: actual.parentId,
      type: actual.type,
      depth: actual.depth,
      path: actual.path,
    }, expected, `Golden Fixture 节点 ${expected.nodeId} 发生结构漂移`);
  }
}

function validateChunks(chunks, treeIds) {
  const chunkIds = new Set();
  let previousChunkId = null;
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.ordinal, index + 1, 'chunk ordinal 必须连续');
    assert.equal(chunkIds.has(chunk.chunkId), false, `chunkId 重复：${chunk.chunkId}`);
    chunkIds.add(chunk.chunkId);
    assert.equal(chunk.charCount, [...chunk.text].length, `chunk ${chunk.chunkId} 的 charCount 不准确`);
    assert.ok(chunk.charCount <= config.maxChars, `chunk ${chunk.chunkId} 超过 maxChars`);
    assert.ok(chunk.nodeIds.every((nodeId) => treeIds.has(nodeId)), `chunk ${chunk.chunkId} 引用了不存在的树节点`);
    assert.equal(chunk.nodeIds.includes('n-root'), false, 'chunk 不得引用虚拟根节点');
    if (chunk.overlapFromChunkId) {
      assert.equal(chunkIds.has(chunk.overlapFromChunkId), true, `chunk ${chunk.chunkId} 的 overlap 来源必须是前序 chunk`);
      assert.ok(chunk.overlapChars > 0);
    }
    previousChunkId = chunk.chunkId;
  }
  assert.ok(chunks.length > 1, '稳定性夹具必须产生多个 chunk');
  assert.ok(chunks.some((chunk) => chunk.boundaryReason === 'body-hard-limit'), '必须覆盖正文硬上限切分');
  assert.ok(chunks.some((chunk) => chunk.overlapChars > 0), '必须覆盖正常边界 overlap');
  assert.equal(previousChunkId, chunks.at(-1)?.chunkId ?? null);
}

const treeAPath = treeA;
const treeBPath = treeB;
const treeResumePath = treeResume;
const chunksAPath = chunksA;
const chunksBPath = chunksB;
const chunksResumePath = chunksResume;
const treeNodes = readJsonLines(path.join(treeAPath, 'structure.jsonl'));
const treeIds = validateTree(treeNodes);
validateGoldenTree(treeNodes);
assertStableStage('tree 重复运行', treeAPath, treeBPath, [['structure.jsonl', true], ['structure.json', false], ['tree-report.json', false]]);
assertStableStage('tree 断点恢复', treeAPath, treeResumePath, [['structure.jsonl', true], ['structure.json', false], ['tree-report.json', false]]);
assertStableStage('chunks 重复运行', chunksAPath, chunksBPath, [['chunks.jsonl', true], ['chunks-report.json', false]]);
assertStableStage('chunks 断点恢复', chunksAPath, chunksResumePath, [['chunks.jsonl', true], ['chunks-report.json', false]]);

const chunks = readJsonLines(path.join(chunksAPath, 'chunks.jsonl'));
validateChunks(chunks, treeIds);
const chunksReport = JSON.parse(readFileSync(path.join(chunksAPath, 'chunks-report.json'), 'utf8'));
assert.equal(chunksReport.counts.oversizeChunks, 0, '稳定性夹具不应产生 oversize chunk');
assert.ok(chunksReport.counts.maxChunkChars <= config.maxChars);
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
assert.ok(summary.tree.nodes >= 5000, 'P6 必须覆盖大文档树结构');
assert.ok(summary.chunks.chunks > 1);

await commitTreeStage(layout, treeAPath);
await commitChunksStage(layout, chunksAPath);
assert.equal(await isStageCacheValid(layout, 'tree'), true, '完整树产物应命中缓存');
assert.equal(await isStageCacheValid(layout, 'chunks'), true, '完整 chunk 产物应命中缓存');

const committedChunksPath = path.join(layout.chunksDirectory, 'chunks.jsonl');
const committedChunks = readFileSync(committedChunksPath);
writeFileSync(committedChunksPath, Buffer.concat([committedChunks, Buffer.from('{"tampered":true}\n', 'utf8')]));
assert.equal(await isStageCacheValid(layout, 'chunks'), false, '缓存必须检测产物篡改');
writeFileSync(committedChunksPath, committedChunks);
assert.equal(await isStageCacheValid(layout, 'chunks'), true, '恢复原始产物后缓存应重新有效');

const changedStructureLayout = prepareParseLayout(libraryDir, document, '', 'p4-stability', structureConfigHash({ ...config, targetChars: 400, maxChars: 600 }));
assert.equal(treeStageKey(changedStructureLayout), treeStageKey(layout), '切块配置变化不应改变 tree key');
assert.notEqual(chunksStageKey(changedStructureLayout), chunksStageKey(layout), '切块配置变化必须改变 chunks key');
assert.equal(await isStageCacheValid(changedStructureLayout, 'tree'), true, '切块配置变化应保留 tree 缓存');
assert.equal(await isStageCacheValid(changedStructureLayout, 'chunks'), false, '切块配置变化应使 chunks 缓存失效');

const changedAmbiguityLayout = prepareParseLayout(libraryDir, document, '', 'p4-stability-changed', structureConfigHash(config));
assert.notEqual(treeStageKey(changedAmbiguityLayout), treeStageKey(layout), '歧义配置变化必须改变 tree key');
assert.equal(await isStageCacheValid(changedAmbiguityLayout, 'tree'), false);
assert.equal(await isStageCacheValid(changedAmbiguityLayout, 'chunks'), false);

const changedDocument = { ...document, contentHash: crypto.createHash('sha256').update(`${document.contentHash}:changed`).digest('hex') };
const changedSourceLayout = prepareParseLayout(libraryDir, changedDocument, '', 'p4-stability', structureConfigHash(config));
assert.equal(await isStageCacheValid(changedSourceLayout, 'tree'), false, '源文档 hash 变化必须隔离旧 tree 缓存');
assert.equal(await isStageCacheValid(changedSourceLayout, 'chunks'), false, '源文档 hash 变化必须隔离旧 chunks 缓存');

removePipelineArtifacts(libraryDir, document.id);
assert.equal(existsSync(layout.documentRoot), false, '删除文档时必须清理全部流水线缓存');

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-p6: deterministic tree/chunk outputs, golden structure, checkpoint recovery, referential integrity, cache boundaries, tamper detection, and large-document stability passed');
