import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.p3');
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { prepareParseLayout, commitParseStage, commitLinesStage, commitSignalsStage, createStageTempDirectory, isStageCacheValid, linesStageKey, signalsStageKey } from './electron/pipeline/artifactStore';
      export { runDirectTextParse } from './electron/pipeline/textStage';
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
  commitLinesStage,
  commitParseStage,
  commitSignalsStage,
  createParseImageSink,
  createStageTempDirectory,
  isStageCacheValid,
  linesStageKey,
  prepareParseLayout,
  runDirectTextParse,
  signalsStageKey,
} = await import(pathToFileURL(outFile).href);

const sourcePath = path.join(documentsDir, 'structure-fixture.md');
const fixture = [
  '# 文档标题',
  '',
  '第一章 总则',
  '第一步：安装依赖',
  '1.2 适用范围',
  '| 名称 | 说明 |',
  '| --- | --- |',
  '> 引用内容',
  '- [x] 已完成',
  '- 普通列表',
  '1. 有序列表',
  '（一）范围',
  '第 1 页',
  '普通正文内容。',
  'A | B 是正文中的竖线。',
  ...Array.from({ length: 4_985 }, (_, index) => index % 37 === 0 ? `正文第 ${index} 行` : '正文补充内容。'),
].join('\n');
writeFileSync(sourcePath, fixture, 'utf8');

const document = {
  id: 'd3',
  name: 'structure-fixture.md',
  relativePath: 'documents/structure-fixture.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: Buffer.byteLength(fixture),
  addedAt: new Date().toISOString(),
  contentHash: 'c'.repeat(64),
  vectorState: 'pending',
};

const layout = prepareParseLayout(libraryDir, document);
const parseTemp = createStageTempDirectory(layout, 'parse', 'job-p3-parse');
const parseResult = await runDirectTextParse({ inputPath: sourcePath, outputDir: parseTemp, extension: '.md', signal: new AbortController().signal });
assert.equal(parseResult.counts.lines, 5_000);
createParseImageSink(parseTemp).writeManifest(parseTemp);
await commitParseStage(layout, parseTemp);
assert.equal(await isStageCacheValid(layout, 'parse'), true);

const python = String(process.env.PYTHON ?? 'python');
const pythonScript = String.raw`
import json, sys
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path.cwd()))
from pipeline_worker.lines_stage import run_lines_stage
from pipeline_worker.signals_stage import run_signals_stage

parse_dir, lines_dir, signals_dir, lines_key, signals_key = sys.argv[1:]
cancel = Event()
def cancel_lines(completed, total, unit, message):
    if completed >= 1200:
        cancel.set()
try:
    run_lines_stage(parse_dir, lines_dir, cancel, cancel_lines, lines_key)
except Exception as exc:
    if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
        raise
run_lines_stage(parse_dir, lines_dir, Event(), lambda *_args: None, lines_key)
assert '\n\n' not in (Path(parse_dir) / 'document.md').read_text(encoding='utf-8')
line_values = [json.loads(value) for value in (Path(lines_dir) / 'lines.jsonl').read_text(encoding='utf-8').splitlines()]
assert len(line_values) == 4999
assert [value['lineNo'] for value in line_values] == list(range(1, 5000))
assert all(value['normalizedText'] for value in line_values)
assert line_values[1]['blankBefore'] is True

signal_cancel = Event()
def cancel_signals(completed, total, unit, message):
    if completed >= 800:
        signal_cancel.set()
try:
    run_signals_stage(str(Path(lines_dir) / 'lines.jsonl'), signals_dir, 'd3', 'c' * 64, signal_cancel, cancel_signals, signals_key)
except Exception as exc:
    if getattr(exc, 'code', '') != 'STAGE_CANCELLED':
        raise
signal_counts = run_signals_stage(str(Path(lines_dir) / 'lines.jsonl'), signals_dir, 'd3', 'c' * 64, Event(), lambda *_args: None, signals_key)
assert signal_counts['signals'] == 4999
batches = [json.loads(value) for value in (Path(signals_dir) / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
signals = [signal for batch in batches for signal in batch['signals']]
assert len(signals) == 4999
assert len({signal['signalId'] for signal in signals}) == 4999
assert batches[0]['documentTitle']['type'] == 'DOCUMENT_TITLE'
expected = ['HEADING', 'HEADING', 'STEP_ITEM', 'HEADING', 'TABLE_ROW', 'TABLE_ROW', 'QUOTE', 'LIST_ITEM', 'LIST_ITEM', 'HEADING_CANDIDATE', 'HEADING_CANDIDATE', 'NOISE', 'BODY', 'BODY']
assert [signal['type'] for signal in signals[:14]] == expected
assert signals[9]['confidence'] == 0.7
assert signals[10]['confidence'] == 0.7
assert signals[9]['scoreBreakdown']['markerFamily'] == 'arabic'
assert signals[10]['scoreBreakdown']['markerFamily'] == 'chinese'
assert signals[9]['scoreBreakdown']['sequenceDetected'] == False
assert signals[10]['scoreBreakdown']['sequenceDetected'] == False
assert signal_counts['headingCandidates'] >= 1
`;
const pythonResult = spawnSync(python, ['-c', pythonScript, layout.parseDirectory, path.join(layout.documentRoot, '.02-lines.tmp-p3'), path.join(layout.documentRoot, '.03-signals.tmp-p3'), linesStageKey(layout), signalsStageKey(layout)], {
  cwd: path.join(rootDir, 'pipeline-python'),
  encoding: 'utf8',
  windowsHide: true,
});
if (pythonResult.status !== 0) throw new Error(`P3 Python stage verification failed:\n${pythonResult.stdout}\n${pythonResult.stderr}`);

const linesTemp = path.join(layout.documentRoot, '.02-lines.tmp-p3');
const signalsTemp = path.join(layout.documentRoot, '.03-signals.tmp-p3');
await commitLinesStage(layout, linesTemp);
await commitSignalsStage(layout, signalsTemp);
assert.equal(await isStageCacheValid(layout, 'lines'), true);
assert.equal(await isStageCacheValid(layout, 'signals'), true);
assert.equal(existsSync(path.join(layout.linesDirectory, 'lines.jsonl')), true);
assert.equal(existsSync(path.join(layout.signalsDirectory, 'signals.jsonl')), true);
assert.equal(existsSync(path.join(layout.checkpointDirectory, 'stage-signals.json')), true);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-p3: streamed lines, scored outline signals, checkpoint resume, provenance, and stage cache validation passed');
