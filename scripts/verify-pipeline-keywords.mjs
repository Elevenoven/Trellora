import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.keyword-baseline-verification');
const bundlePath = path.join(outDir, 'keyword-config.cjs');
const reportPath = path.join(outDir, 'baseline-report.json');
const fixturePath = path.join(rootDir, 'pipeline-python', 'tests', 'fixtures', 'keyword-baseline-fixtures.json');
const resourceManifestPath = path.join(rootDir, 'pipeline-python', 'pipeline_worker', 'resources', 'keyword-resource-manifest.json');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `export { DEFAULT_KEYWORD_EXTRACTION_CONFIG, normalizeKeywordExtractionConfig, keywordConfigHash } from './electron/pipeline/keywordConfig';`,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const configModule = await import(pathToFileURL(bundlePath).href);
const defaults = configModule.DEFAULT_KEYWORD_EXTRACTION_CONFIG;
const normalized = configModule.normalizeKeywordExtractionConfig({
  enabled: 'yes',
  minScore: 2,
  minKeywords: 8,
  maxKeywords: 2,
  maxCandidatesPerChunk: 1,
  textRank: { damping: 2, maxIterations: 1 },
  weights: { tfidf: 0, textRank: 0, position: 0, sentenceSpread: 0, sectionMatch: 0, termQuality: 0 },
});
assert.equal(defaults.enabled, true);
assert.equal(defaults.hmm, false);
assert.equal(normalized.minScore, 1);
assert.equal(normalized.minKeywords, 5);
assert.equal(normalized.maxKeywords, 5);
assert.equal(normalized.maxCandidatesPerChunk, 32);
assert.equal(normalized.textRank.damping, 0.95);
assert.equal(normalized.textRank.maxIterations, 10);
assert.equal(configModule.keywordConfigHash(defaults), configModule.keywordConfigHash({ ...defaults }));
assert.notEqual(
  configModule.keywordConfigHash(defaults, { tokenizerVersion: 'jieba-a' }),
  configModule.keywordConfigHash(defaults, { tokenizerVersion: 'jieba-b' }),
);

const python = String(process.env.PYTHON ?? 'python');
const pythonResult = spawnSync(python, [
  '-m', 'pipeline_worker.keyword_baseline',
  '--fixtures', path.relative(path.join(rootDir, 'pipeline-python'), fixturePath),
  '--report', path.relative(path.join(rootDir, 'pipeline-python'), reportPath),
], {
  cwd: path.join(rootDir, 'pipeline-python'),
  encoding: 'utf8',
  windowsHide: true,
});
if (pythonResult.status !== 0) {
  throw new Error(`关键词 baseline 验证失败:\n${pythonResult.stdout}\n${pythonResult.stderr}`);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.equal(report.fixtureCount, 40);
assert.equal(report.offsetAccuracy, 1);
assert.equal(report.deterministic, true);
assert.ok(report.durationMs >= 0);
assert.ok(report.recallAt5 > 0);
const resourceManifest = JSON.parse(readFileSync(resourceManifestPath, 'utf8'));
assert.equal(resourceManifest.dependencies.find((item) => item.name === 'jieba')?.version, '0.42.1');
assert.equal(resourceManifest.dependencies.find((item) => item.name === 'jieba')?.license, 'MIT');
for (const resource of resourceManifest.resources) {
  assert.equal(existsSync(path.join(rootDir, 'pipeline-python', resource.path)), true);
}
const candidateTests = spawnSync(python, ['-m', 'unittest', 'tests/test_keyword_baseline.py', 'tests/test_keyword_candidates.py', 'tests/test_keyword_ranker.py', 'tests/test_keyword_stage.py', 'tests/test_keyword_worker.py', '-q'], {
  cwd: path.join(rootDir, 'pipeline-python'),
  encoding: 'utf8',
  windowsHide: true,
});
if (candidateTests.status !== 0) {
  throw new Error(`关键词 tokenizer/candidate tests failed:\n${candidateTests.stdout}\n${candidateTests.stderr}`);
}
assert.equal(existsSync(path.join(rootDir, 'pipeline-python', 'pipeline_worker', 'worker.py')), true);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-keywords: contract, deterministic baseline, tokenizer/candidate generation, hybrid ranking, two-pass stage, checkpoint resume, Worker NDJSON, fixture quality, timing, and offset evidence passed');
