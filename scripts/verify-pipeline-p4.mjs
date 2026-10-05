import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.p4');
const outFile = path.join(outDir, 'pipeline.cjs');
const libraryDir = path.join(outDir, 'library');
const documentsDir = path.join(libraryDir, 'documents');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(documentsDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export { runAmbiguityStage } from './electron/pipeline/ambiguityStage';
      export { ambiguityConfigHash } from './electron/pipeline/ambiguityConfig';
      export { prepareParseLayout, commitAmbiguityStage, isStageCacheValid, ambiguityStageKey } from './electron/pipeline/artifactStore';
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
  ambiguityConfigHash,
  ambiguityStageKey,
  commitAmbiguityStage,
  isStageCacheValid,
  prepareParseLayout,
  runAmbiguityStage,
} = await import(pathToFileURL(outFile).href);

const sourcePath = path.join(documentsDir, 'ambiguity-fixture.md');
writeFileSync(sourcePath, '# fixture\n', 'utf8');
const document = {
  id: 'd4',
  name: 'ambiguity-fixture.md',
  relativePath: 'documents/ambiguity-fixture.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: 10,
  addedAt: new Date().toISOString(),
  contentHash: 'd'.repeat(64),
  vectorState: 'pending',
};
const config = {
  enabled: true,
  minConfidence: 0.35,
  maxConfidence: 0.85,
  maxCandidatesPerBatch: 1,
  maxInputCharacters: 8_000,
  timeoutMs: 5_000,
  maxOutputTokens: 128,
  promptVersion: 'p4-test-1',
};
const model = { provider: 'test-provider', model: 'test-model', available: true };
const layout = prepareParseLayout(libraryDir, document, '', ambiguityConfigHash(config, model));
const signalsPath = path.join(layout.signalsDirectory, 'signals.jsonl');
mkdirSync(layout.signalsDirectory, { recursive: true });
const batch = {
  schemaVersion: 1,
  documentId: 'd4',
  contentHash: document.contentHash,
  batchIndex: 0,
  firstLineNo: 1,
  lastLineNo: 4,
  contextText: '候选标题\n另一个候选\n明确正文',
  documentTitle: { signalId: 's-title', lineNo: 0, type: 'DOCUMENT_TITLE', rawText: 'fixture' },
  signals: [
    { signalId: 's-1', lineNo: 1, type: 'HEADING_CANDIDATE', rawText: '1、安装步骤', normalizedText: '1、安装步骤', confidence: 0.58, ruleId: 'ambiguous-outline-score', scoreBreakdown: { base: 0.5, plainHeading: 0.2, markerFamily: 'arabic', markerValue: 1, sequenceDetected: false } },
    { signalId: 's-2', lineNo: 2, type: 'HEADING_CANDIDATE', rawText: '第二个候选', normalizedText: '第二个候选', confidence: 0.62, ruleId: 'heading-candidate' },
    { signalId: 's-3', lineNo: 3, type: 'HEADING_CANDIDATE', rawText: '高置信度候选', normalizedText: '高置信度候选', confidence: 0.9, ruleId: 'heading-candidate' },
    { signalId: 's-4', lineNo: 4, type: 'BODY', rawText: '正文。', normalizedText: '正文。', confidence: 0.75, ruleId: 'fallback-body' },
  ],
};
writeFileSync(signalsPath, `${JSON.stringify(batch)}\n`, 'utf8');

let validCalls = 0;
let validPrompt = '';
const validTemp = path.join(layout.documentRoot, '.04-ambiguity.tmp-valid');
const validStats = await runAmbiguityStage({
  inputPath: signalsPath,
  outputDir: validTemp,
  documentId: 'd4',
  contentHash: document.contentHash,
  stageKey: ambiguityStageKey(layout),
  config,
  model: {
    ...model,
    generateJson: async ({ prompt }) => {
      validCalls += 1;
      validPrompt = prompt;
      assert.ok(prompt.length <= config.maxInputCharacters);
      return { decisions: [{ signalId: 's-1', decision: 'HEADING', confidence: 0.88, reasonCode: 'heading-context' }] };
    },
  },
  signal: new AbortController().signal,
});
assert.equal(validCalls, 1);
assert.equal(validStats.requests, 1);
assert.equal(validStats.applied, 1);
assert.equal(validStats.fallbackReasons['candidate-limit'], 1);
assert.match(validPrompt, /文档结构判定助手/);
assert.match(validPrompt, /连续编号项、步骤、操作清单/);
assert.match(validPrompt, /候选数据开始/);
assert.match(validPrompt, /"decisions"/);
assert.match(validPrompt, /"signalId"/);
assert.match(validPrompt, /"scoreBreakdown"/);
assert.doesNotMatch(validPrompt, /resolved_kind|level_hint|BODY/);
const validSignals = JSON.parse(readFileSync(path.join(validTemp, 'ambiguity.jsonl'), 'utf8'));
assert.equal(validSignals.signals.find((signal) => signal.signalId === 's-1').type, 'HEADING');
assert.equal(validSignals.signals.find((signal) => signal.signalId === 's-2').type, 'HEADING_CANDIDATE');
assert.equal(validSignals.signals.find((signal) => signal.signalId === 's-3').type, 'HEADING_CANDIDATE');
await commitAmbiguityStage(layout, validTemp);
assert.equal(await isStageCacheValid(layout, 'ambiguity'), true);
assert.equal(existsSync(path.join(layout.ambiguityDirectory, 'ambiguity-report.json')), true);

let invalidCalls = 0;
const invalidTemp = path.join(layout.documentRoot, '.04-ambiguity.tmp-invalid');
const invalidStats = await runAmbiguityStage({
  inputPath: signalsPath,
  outputDir: invalidTemp,
  documentId: 'd4',
  contentHash: document.contentHash,
  stageKey: `${ambiguityStageKey(layout)}-invalid`,
  config: { ...config, maxCandidatesPerBatch: 8 },
  model: {
    ...model,
    generateJson: async () => {
      invalidCalls += 1;
      return { decisions: [{ signalId: 'not-a-candidate', decision: 'HEADING', confidence: 0.9, reasonCode: 'invalid' }] };
    },
  },
  signal: new AbortController().signal,
});
assert.equal(invalidCalls, 1);
assert.equal(invalidStats.applied, 0);
assert.equal(invalidStats.fallbackReasons['invalid-output'], 2);

let disabledCalls = 0;
const disabledTemp = path.join(layout.documentRoot, '.04-ambiguity.tmp-disabled');
const disabledStats = await runAmbiguityStage({
  inputPath: signalsPath,
  outputDir: disabledTemp,
  documentId: 'd4',
  contentHash: document.contentHash,
  stageKey: 'disabled',
  config: { ...config, enabled: false },
  model: {
    ...model,
    generateJson: async () => {
      disabledCalls += 1;
      return {};
    },
  },
  signal: new AbortController().signal,
});
assert.equal(disabledCalls, 0);
assert.equal(disabledStats.requests, 0);
assert.equal(disabledStats.applied, 0);
assert.equal(JSON.parse(readFileSync(path.join(disabledTemp, 'ambiguity.jsonl'), 'utf8')).signals[0].type, 'HEADING_CANDIDATE');

const changedLayout = prepareParseLayout(libraryDir, document, '', ambiguityConfigHash({ ...config, promptVersion: 'p4-test-2' }, model));
assert.equal(await isStageCacheValid(changedLayout, 'ambiguity'), false);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-p4: bounded candidate submission, strict validation, silent fallback, disabled zero-request path, and cache invalidation passed');
