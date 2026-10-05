import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// This verifier covers the retained legacy artifact contract explicitly.
process.env.MENGHAN_PIPELINE_CHUNKING_V2 = '0';
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.p5');
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { prepareParseLayout, commitTreeStage, commitChunksStage, isStageCacheValid, treeStageKey, chunksStageKey } from './electron/pipeline/artifactStore';
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
  prepareParseLayout,
  structureConfigHash,
  treeStageKey,
} = await import(pathToFileURL(outFile).href);

const sourcePath = path.join(documentsDir, 'p5-fixture.md');
const source = '# P5 fixture\n';
writeFileSync(sourcePath, source, 'utf8');
const document = {
  id: 'd5',
  name: 'p5-fixture.md',
  relativePath: 'documents/p5-fixture.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: Buffer.byteLength(source),
  addedAt: new Date().toISOString(),
  contentHash: 'e'.repeat(64),
  vectorState: 'pending',
};
const config = { strategy: 'heading', targetChars: 200, overlapChars: 8, minChars: 10, maxChars: 300 };
const layout = prepareParseLayout(libraryDir, document, '', 'p4-test', structureConfigHash(config));
mkdirSync(layout.ambiguityDirectory, { recursive: true });

const fixtureSignals = [
  { lineNo: 1, type: 'HEADING', text: '# 第一章 总则', ruleId: 'markdown-heading' },
  { lineNo: 2, type: 'HEADING', text: '1 适用范围', ruleId: 'numeric-heading' },
  { lineNo: 3, type: 'HEADING', text: '1.1 目标', ruleId: 'numeric-heading' },
  { lineNo: 4, type: 'LIST_ITEM', text: '- 父列表', ruleId: 'unordered-list' },
  { lineNo: 5, type: 'LIST_ITEM', text: '  - 子列表', ruleId: 'unordered-list' },
  { lineNo: 6, type: 'BODY', text: '列表项的说明正文。', ruleId: 'fallback-body' },
  { lineNo: 7, type: 'TABLE_ROW', text: '| 名称 | 说明 |', ruleId: 'table-row' },
  { lineNo: 8, type: 'QUOTE', text: '> 引用内容', ruleId: 'quote' },
  { lineNo: 9, type: 'BLANK', text: '', ruleId: 'blank' },
  { lineNo: 10, type: 'BODY', text: '孤立正文。', ruleId: 'fallback-body' },
  ...Array.from({ length: 440 }, (_, index) => ({
    lineNo: index + 11,
    type: 'BODY',
    text: `长文档正文第 ${index + 11} 行，用于验证 P5 的 checkpoint 恢复和稳定 chunk。`,
    ruleId: 'fallback-body',
  })),
  { lineNo: 451, type: 'BODY', text: '超长正文'.repeat(160), ruleId: 'fallback-body' },
];
const batchSize = 50;
const batches = [];
for (let index = 0; index < fixtureSignals.length; index += batchSize) {
  const signals = fixtureSignals.slice(index, index + batchSize).map((signal) => ({
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
    ...(batches.length === 0 ? { documentTitle: { signalId: 's-title', lineNo: 0, type: 'DOCUMENT_TITLE', normalizedText: 'P5 fixture' } } : {}),
    signals,
  });
}
writeFileSync(path.join(layout.ambiguityDirectory, 'ambiguity.jsonl'), `${batches.map((batch) => JSON.stringify(batch)).join('\n')}\n`, 'utf8');
writeFileSync(path.join(layout.ambiguityDirectory, 'ambiguity-report.json'), JSON.stringify({ counts: { signals: fixtureSignals.length } }), 'utf8');

const treeTemp = path.join(layout.documentRoot, '.05-tree.tmp-p5');
const chunksTemp = path.join(layout.documentRoot, '.06-chunks.tmp-p5');
const chunksReplayTemp = path.join(layout.documentRoot, '.06-chunks.tmp-p5-replay');
const pythonScript = String.raw`
import json, sys
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path.cwd()))
from pipeline_worker.structure_stage import run_structure_chunks_stage, run_structure_tree_stage

ambiguity_dir, tree_dir, chunks_dir, replay_dir, tree_key, chunks_key, document_id, content_hash, config_json = sys.argv[1:]
config = json.loads(config_json)

tree_cancel = Event()
def cancel_tree(completed, total, unit, message):
    if completed >= 100:
        tree_cancel.set()
try:
    run_structure_tree_stage(ambiguity_dir, tree_dir, document_id, content_hash, tree_cancel, cancel_tree, tree_key)
except Exception as exc:
    if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
        raise
tree_counts = run_structure_tree_stage(ambiguity_dir, tree_dir, document_id, content_hash, Event(), lambda *_args: None, tree_key)
assert tree_counts['rootNodes'] == 1
tree_nodes = [json.loads(value) for value in (Path(tree_dir) / 'structure.jsonl').read_text(encoding='utf-8').splitlines()]
assert len({node['nodeId'] for node in tree_nodes}) == len(tree_nodes)
assert sum(1 for node in tree_nodes if node['parentId'] is None) == 1
by_id = {node['nodeId']: node for node in tree_nodes}
assert by_id['n-s-000002']['parentId'] == 'n-title'
assert by_id['n-s-000003']['parentId'] == 'n-s-000002'
assert by_id['n-s-000004']['parentId'] == 'n-s-000003'
assert by_id['n-s-000005']['parentId'] == 'n-s-000004'
assert by_id['n-s-000006']['parentId'] == 'n-s-000005'
assert by_id['n-s-000010']['parentId'] != 'n-s-000006'
assert all(node['parentId'] is None or node['parentId'] in by_id for node in tree_nodes)

chunks_cancel = Event()
def cancel_chunks(completed, total, unit, message):
    if completed >= 200:
        chunks_cancel.set()
try:
    run_structure_chunks_stage(tree_dir, chunks_dir, document_id, content_hash, config, chunks_cancel, cancel_chunks, chunks_key)
except Exception as exc:
    if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
        raise
chunk_counts = run_structure_chunks_stage(tree_dir, chunks_dir, document_id, content_hash, config, Event(), lambda *_args: None, chunks_key)
replay_counts = run_structure_chunks_stage(tree_dir, replay_dir, document_id, content_hash, config, Event(), lambda *_args: None, chunks_key)
chunks = [json.loads(value) for value in (Path(chunks_dir) / 'chunks.jsonl').read_text(encoding='utf-8').splitlines()]
replay = [json.loads(value) for value in (Path(replay_dir) / 'chunks.jsonl').read_text(encoding='utf-8').splitlines()]
assert chunk_counts['chunks'] == replay_counts['chunks']
assert [item['chunkId'] for item in chunks] == [item['chunkId'] for item in replay]
assert all(item['charCount'] <= config['maxChars'] for item in chunks)
assert any(item['boundaryReason'] == 'heading-boundary' for item in chunks)
assert any(item['boundaryReason'] == 'body-hard-limit' for item in chunks)
assert all('n-root' not in item['nodeIds'] for item in chunks)
assert any(item['overlapChars'] > 0 for item in chunks[1:])
`;
const pythonResult = spawnSync(String(process.env.PYTHON ?? 'python'), ['-c', pythonScript, layout.ambiguityDirectory, treeTemp, chunksTemp, chunksReplayTemp, treeStageKey(layout), chunksStageKey(layout), document.id, document.contentHash, JSON.stringify(config)], {
  cwd: path.join(rootDir, 'pipeline-python'),
  encoding: 'utf8',
  windowsHide: true,
});
if (pythonResult.status !== 0) throw new Error(`P5 Python stage verification failed:\n${pythonResult.stdout}\n${pythonResult.stderr}`);

await commitTreeStage(layout, treeTemp);
await commitChunksStage(layout, chunksTemp);
assert.equal(await isStageCacheValid(layout, 'tree'), true);
assert.equal(await isStageCacheValid(layout, 'chunks'), true);
assert.equal(existsSync(path.join(layout.treeDirectory, 'structure.jsonl')), true);
assert.equal(existsSync(path.join(layout.chunksDirectory, 'chunks.jsonl')), true);

const changedLayout = prepareParseLayout(libraryDir, document, '', 'p4-test', structureConfigHash({ ...config, targetChars: 400, maxChars: 600 }));
assert.equal(await isStageCacheValid(changedLayout, 'tree'), true);
assert.equal(await isStageCacheValid(changedLayout, 'chunks'), false);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-p5: linear tree assembly, parent/path/source validation, checkpoint resume, stable chunk IDs, hard-limit handling, and cache invalidation passed');
